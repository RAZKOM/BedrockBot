// Track E8 (docs/farming.md "Water for the plot", ADR 0105): the starter plot's water: surface sources only, pools
// tried nearest first, water remembered by the world cache, the bounded search walk, and the reply's reason.
import { describe, expect, it } from 'vitest';
import { checkSite, type PlotSite } from '../../../src/skills/farm/plot.ts';
import { breakForSeeds, FarmPlotJob, type PlotJobDeps } from '../../../src/skills/farm/setup.ts';
import { FarmChore, SEED_TOPUP_EVERY, type FarmChoreDeps } from '../../../src/tasks/process/farm-new.ts';
import { openAbove, poolsOf, searchLegs, surfaceSource, WATER_SEEN, waterPools } from '../../../src/skills/farm/water.ts';
import type { BlockInfo, Vec3 } from '../../../src/world/types.ts';

const b = (name: string, solid = false, states: Record<string, unknown> = {}): BlockInfo => ({ name, stateId: 0, states, hardness: solid ? 1 : 0, solid, boxes: solid ? [[0, 0, 0, 1, 1, 1]] : [] });
const AIR = b('air');
const GRASS = b('grass_block', true);
const STONE = b('stone', true);
const WATER = b('water', false, { liquid_depth: 0 });
const LEAVES = b('oak_leaves', true);
const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`;

/** Flat grass at 64 over stone; `cells` override; columns where `unloaded(x, z)` read undefined. */
function world(cells: Record<string, BlockInfo>, unloaded: (x: number, z: number) => boolean = () => false) {
  return (p: Vec3): BlockInfo | undefined => (unloaded(p.x, p.z) ? undefined : (cells[key(p)] ?? (p.y < 64 ? STONE : p.y === 64 ? GRASS : AIR)));
}

/** A fake bot: goto walks to the goal unless `blocked(goal)`; the bucket fills on a source; the moves are listed. */
function fakeBot(o: { cells: Record<string, BlockInfo>; unloaded?: (x: number, z: number) => boolean; blocked?: (p: Vec3) => boolean; surface?: Record<string, number> }) {
  const carried: Record<string, number> = { bucket: 1 };
  let feet: Vec3 = { x: 9.5, y: 65, z: 0.5 };
  const seenLoaded = new Set<string>();
  // columns become loaded within 160 of where the bot has stood (the server loads the chunks round it)
  const unloaded = (x: number, z: number): boolean => (o.unloaded?.(x, z) ?? false) && ![...seenLoaded].some((s) => {
    const [fx, fz] = s.split(',').map(Number) as [number, number];
    return Math.hypot(x - fx, z - fz) <= 160;
  });
  const blockAt = world(o.cells, unloaded);
  const goals: Vec3[] = [];
  const clicks: string[] = [];
  const d: PlotJobDeps = {
    world: {
      blockAt,
      find: (pred, q) => {
        const out: Vec3[] = [];
        for (const k of Object.keys(o.cells)) {
          const [x, y, z] = k.split(',').map(Number) as [number, number, number];
          const p = { x, y, z };
          const bl = blockAt(p);
          if (bl && pred(bl, p) && Math.hypot(x + 0.5 - q.origin.x, y + 0.5 - q.origin.y, z + 0.5 - q.origin.z) <= q.radius) out.push(p);
        }
        out.sort((a, c) => Math.hypot(a.x - q.origin.x, a.y - q.origin.y, a.z - q.origin.z) - Math.hypot(c.x - q.origin.x, c.y - q.origin.y, c.z - q.origin.z));
        return out.slice(0, q.max);
      },
      inventory: { count: (n) => carried[n] ?? 0, slots: [] },
      ...(o.surface ? { surfaceAt: (x: number, z: number) => (o.surface![`${x},${z}`] !== undefined ? { name: 'water', y: o.surface![`${x},${z}`]! } : undefined) } : {}),
    },
    skills: {
      goto: async (g) => {
        await Promise.resolve();
        if (!('p' in g) || !g.p) return { ok: false, reason: 'no_goal' };
        goals.push(g.p);
        if (o.blocked?.(g.p)) return { ok: false, reason: 'no_path' };
        feet = { x: g.p.x, y: 65, z: g.p.z + 1 };
        seenLoaded.add(`${Math.floor(feet.x)},${Math.floor(feet.z)}`);
        return { ok: true };
      },
      dig: async (p) => {
        await Promise.resolve();
        o.cells[key(p)] = AIR;
        return { ok: true } as never;
      },
      place: async (p, q) => {
        await Promise.resolve();
        if (q?.item === 'water_bucket' && carried.water_bucket) {
          o.cells[key(p)] = WATER;
          carried.water_bucket--;
          carried.bucket = 1;
          return { ok: true };
        }
        return { ok: false, reason: 'no_item' };
      },
      collect: () => Promise.resolve({ ok: true } as never),
    },
    click: async (p, item) => {
      await Promise.resolve();
      clicks.push(`${key(p)} ${item}`);
      if (item === 'bucket' && blockAt(p)?.name === 'water') {
        carried.bucket = 0;
        carried.water_bucket = 1;
        return { ok: true };
      }
      return { ok: false, reason: 'rejected' };
    },
    farm: { start: () => Promise.resolve('done'), stop: () => undefined, stats: { planted: 0 } },
    position: () => feet,
    now: () => 0,
  };
  return { d, goals, clicks, carried, blockAt, find: d.world.find.bind(d.world) };
}

const home = { x: 0.5, y: 65, z: 0.5 };
const site = (blockAt: (p: Vec3) => BlockInfo | undefined, n = 3): PlotSite => checkSite((p) => blockAt(p) ?? AIR, { x: 9, y: 64, z: 0 }, n, { n }, home) as PlotSite;

describe('surface water (Track E8)', () => {
  it('a source under a roof is no surface water; leaves and plants over it are open', () => {
    const cells: Record<string, BlockInfo> = { '5,58,5': WATER, '20,64,0': WATER, '20,70,0': LEAVES };
    const at = world(cells);
    expect(openAbove(at, { x: 5, y: 58, z: 5 })).toBe(false);
    expect(openAbove(at, { x: 20, y: 64, z: 0 })).toBe(true);
    const still = surfaceSource(at);
    expect(still(WATER, { x: 5, y: 58, z: 5 })).toBe(false);
    expect(still(WATER, { x: 20, y: 64, z: 0 })).toBe(true);
    // flowing water is no source; water over water is not the top
    expect(still(b('water', false, { liquid_depth: 3 }), { x: 20, y: 64, z: 0 })).toBe(false);
  });

  it('a cave more than 24 high is no surface water: open up to the plot height and 8 is the rule', () => {
    const cells: Record<string, BlockInfo> = { '20,30,0': WATER };
    for (let y = 31; y <= 63; y++) cells[key({ x: 20, y, z: 0 })] = AIR;
    const at = world(cells);
    expect(surfaceSource(at)(WATER, { x: 20, y: 30, z: 0 })).toBe(true); // 24 cells open
    expect(surfaceSource(at, 64 + 8)(WATER, { x: 20, y: 30, z: 0 })).toBe(false);
    const f = fakeBot({ cells });
    expect(waterPools({ blockAt: f.blockAt, find: f.find }, { x: 9, y: 64, z: 0 }, { x: 9.5, y: 65, z: 0.5 })).toHaveLength(0);
  });

  it('pools: cells within 4 are one pool, nearest the plot first', () => {
    const cells = [
      { x: 40, y: 64, z: 0 },
      { x: 43, y: 64, z: 0 },
      { x: 20, y: 64, z: 10 },
      { x: 21, y: 64, z: 10 },
    ];
    const p = poolsOf(cells, { x: 9.5, y: 64, z: 0.5 });
    expect(p).toHaveLength(2);
    expect(p[0]!.at).toEqual({ x: 20, y: 64, z: 10 });
    expect(p[0]!.cells).toHaveLength(2);
    expect(p[1]!.cells).toHaveLength(2);
  });

  it('the fresh-world fault: a pool 9 under the plot and the sea 23 off; the sea fills the bucket', async () => {
    // before: the six nearest still sources were all in the pool under the plot, tried three times, never reached,
    // and the reply said "no still water within 96"
    const cells: Record<string, BlockInfo> = {};
    for (let x = 7; x <= 11; x++) for (let z = -2; z <= 2; z++) cells[key({ x, y: 55, z })] = WATER;
    for (let x = 32; x <= 40; x++) for (let z = -4; z <= 4; z++) cells[key({ x, y: 64, z })] = WATER;
    const f = fakeBot({ cells, blocked: (p) => p.y < 60 });
    const pools = waterPools({ blockAt: f.blockAt, find: f.find }, { x: 9, y: 64, z: 0 }, { x: 9.5, y: 65, z: 0.5 });
    expect(pools).toHaveLength(1);
    expect(pools[0]!.at.x).toBe(32);
    const job = new FarmPlotJob(site(f.blockAt), ['water']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.water).toBe('poured');
    expect(job.stats.waterWhy).toBe('filled 23 off');
    expect(job.stats.poolsTried).toBe(1);
  });

  it('a pool not reached costs one try: the next pool fills it', async () => {
    const cells: Record<string, BlockInfo> = { '30,64,0': WATER, '31,64,0': WATER, '9,64,40': WATER };
    const f = fakeBot({ cells, blocked: (p) => p.x > 25 });
    const job = new FarmPlotJob(site(f.blockAt), ['water']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.water).toBe('poured');
    expect(job.stats.poolsTried).toBe(2);
    expect(job.stats.waterWhy).toBe('filled 40 off');
  });

  it('a walk back that ends out of reach of the middle: tried again, then dry with the water kept and the cause', async () => {
    const cells: Record<string, BlockInfo> = { '30,64,0': WATER, '31,64,0': WATER };
    let back = 0;
    // every walk toward the plot fails once the bucket is full
    const f = fakeBot({ cells, blocked: (p) => p.x < 20 && (back++, true) });
    const job = new FarmPlotJob(site(f.blockAt), ['water']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(back).toBe(2);
    expect(job.stats.water).toBe('dry');
    expect(job.stats.waterWhy).toBe('water carried, not back at the plot (no_path)');
    expect(f.carried.water_bucket).toBe(1);
  });

  it('water the world cache remembers 200 off (not loaded now) is walked to and fills the bucket', async () => {
    const cells: Record<string, BlockInfo> = { '210,64,0': WATER };
    const f = fakeBot({ cells, unloaded: (x) => x > 150, surface: { '210,0': 64 } });
    const job = new FarmPlotJob(site(f.blockAt), ['water']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.water).toBe('poured');
    expect(job.stats.waterWhy).toBe('filled 201 off, seen before');
    expect(f.goals[0]).toEqual({ x: 210.5, y: 64, z: 0.5 });
  });

  it('nothing seen: the search walk goes out along x first and finds water past the loaded ground', async () => {
    const cells: Record<string, BlockInfo> = { '230,64,5': WATER };
    const f = fakeBot({ cells, unloaded: (x) => x > 169 });
    const job = new FarmPlotJob(site(f.blockAt), ['water']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.water).toBe('poured');
    expect(job.stats.waterWhy).toMatch(/^filled 221 off, walked \d+ looking$/);
    // the first step out (32 along +x) brought it in view
    expect(f.goals[0]).toEqual({ x: 41.5, y: 65, z: 0.5 });
  });

  it('nothing within 256: the four legs walked, the plot dry, the reply says how far it looked', async () => {
    const cells: Record<string, BlockInfo> = { '400,64,0': WATER };
    const f = fakeBot({ cells });
    const job = new FarmPlotJob(site(f.blockAt), ['water']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.water).toBe('dry');
    expect(job.stats.waterWhy).toMatch(/^none seen within 256, walked \d+ looking$/);
    const legs = searchLegs({ x: 9, y: 64, z: 0 });
    expect(f.goals.length).toBe(legs.flat().length);
    expect(job.stats.waterWalked).toBeGreaterThan(4 * 96);
    expect(WATER_SEEN).toBe(256);
  });

  it('pools seen but none reached: the reason names how many and the nearest', async () => {
    const cells: Record<string, BlockInfo> = { '30,64,0': WATER, '9,64,40': WATER };
    const f = fakeBot({ cells, blocked: (p) => (p.x > 25 && p.z === 0.5) || p.z > 30 });
    const job = new FarmPlotJob(site(f.blockAt), ['water']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.water).toBe('dry');
    expect(job.stats.waterWhy).toMatch(/^2 tried, none reached, nearest 21 off, walked \d+$/);
  });

  it('seeds: every plant in reach broken from one stand; ferns count', async () => {
    const cells: Record<string, BlockInfo> = {};
    for (let x = 20; x <= 23; x++) for (let z = 0; z <= 1; z++) cells[key({ x, y: 65, z })] = b(x === 23 ? 'fern' : 'short_grass');
    const f = fakeBot({ cells });
    let broken = 0;
    f.d.skills.dig = async (p) => {
      await Promise.resolve();
      cells[key(p)] = AIR;
      broken++;
      return { ok: true } as never;
    };
    const stats = { grassBroken: 0 };
    expect(await breakForSeeds(f.d, { centre: { x: 9, y: 64, z: 0 }, range: 24, want: 99, until: () => false }, () => false, stats)).toBe(true);
    expect(stats.grassBroken).toBe(8);
    expect(broken).toBe(8);
    // one walk to the patch (before: one a plant)
    expect(f.goals.length).toBeLessThanOrEqual(2);
  });

  it('seeds: no grass within 24 of the plot, some 36 off: the step looks out to 48', async () => {
    const cells: Record<string, BlockInfo> = {};
    for (let z = 0; z <= 7; z++) cells[key({ x: 45, y: 65, z })] = b('short_grass');
    const f = fakeBot({ cells });
    let broken = 0;
    f.d.skills.dig = async (p) => {
      await Promise.resolve();
      cells[key(p)] = AIR;
      broken++;
      return { ok: true } as never;
    };
    const job = new FarmPlotJob(site(f.blockAt), ['seeds']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(broken).toBe(8);
    expect(job.stats.grassBroken).toBe(8);
    expect(job.stop).toMatch(/within 48/);
  });

  it('a cancel in the walk ends the step unfinished (a resume looks again)', async () => {
    const cells: Record<string, BlockInfo> = { '30,64,0': WATER };
    const f = fakeBot({ cells });
    const job = new FarmPlotJob(site(f.blockAt), ['water']);
    let n = 0;
    expect(await job.run(f.d, () => ++n > 0)).toBe(false);
    expect(job.phase).toBe('water');
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.water).toBe('poured');
  });
});

function chore(o: Partial<{ farmFood: boolean; ripe: number; cells: number; crops: number; bare: number; seeds: number; points: number; pass: boolean }> = {}) {
  const s = { farmFood: true, ripe: 0, cells: 80, crops: 21, bare: 59, seeds: 0, points: 30, pass: true, ...o };
  let t = 0;
  const stats = { harvested: 0, planted: 0 };
  const passes: number[] = [];
  const d: FarmChoreDeps = {
    processes: { userProcesses: () => [] } as never,
    settings: { get: ((k: string) => (k === 'farmFood' ? s.farmFood : 10)) as never },
    farm: () => ({ water: { x: 9, y: 64, z: 0 }, n: 9 }),
    position: () => ({ x: 0, y: 65, z: 0 }),
    isDay: () => true,
    foodPoints: () => s.points,
    field: () => ({ ripe: s.ripe, cells: s.cells, crops: s.crops, bare: s.bare }),
    wheat: () => 0,
    foodBusy: () => false,
    seeds: () => s.seeds,
    ...(s.pass
      ? {
          seedPass: async (_w: Vec3, _n: number, want: number) => {
            await Promise.resolve();
            passes.push(want);
            s.seeds += 12;
            return 12;
          },
        }
      : {}),
    farmer: {
      start: async () => {
        await Promise.resolve();
        const n = Math.min(s.seeds, s.bare);
        stats.planted = n;
        stats.harvested = 0;
        s.seeds -= n;
        s.bare -= n;
        s.crops += n;
        return 'done';
      },
      stop: () => undefined,
      stats,
    },
    bread: () => Promise.resolve(0),
    cancel: () => undefined,
    now: () => t,
  };
  return { c: new FarmChore(d), s, passes, tick: (ms: number) => (t += ms) };
}

describe('the seed top-up (Track E8)', () => {
  it('bare cells and nothing ripe: grass broken for seeds, then planted; again only after SEED_TOPUP_EVERY', async () => {
    const k = chore();
    expect(k.c.wants()).toBe(true);
    k.c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(k.passes).toEqual([59]);
    expect(k.c.stats.seedRuns).toBe(1);
    expect(k.c.stats.seedsGot).toBe(12);
    expect(k.c.stats.planted).toBe(12);
    expect(k.s.bare).toBe(47);
    k.tick(6 * 60_000);
    expect(k.c.wants()).toBe(false);
    k.tick(SEED_TOPUP_EVERY);
    expect(k.c.wants()).toBe(true);
  });

  it('seeds carried: no grass broken, they are planted; under 8 bare, no setting, no pass: no run', async () => {
    const k = chore({ seeds: 70 });
    expect(k.c.wants()).toBe(true);
    k.c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(k.passes).toEqual([]);
    expect(k.s.bare).toBe(0);
    expect(chore({ bare: 7 }).c.wants()).toBe(false);
    expect(chore({ farmFood: false }).c.wants()).toBe(false);
    expect(chore({ pass: false }).c.wants()).toBe(false);
  });

  it('a harvest that is due goes first', () => {
    const k = chore({ ripe: 16, crops: 40 });
    expect(k.c.wants()).toBe(true);
    expect(k.c.behaviour()).toBe('farm: harvesting (auto)');
  });
});
