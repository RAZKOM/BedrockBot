// Track E6 (docs/farming.md "A starter farm", ADR 0102): the plot `!farm new` chooses, the own-base rule, the plot job's
// phases on a fake world, and the farm chore's trigger and the food chore's preference for the farm.
import { describe, expect, it } from 'vitest';
import { checkSite, findPlotSite, onRim, ownBase, siteWhyText, type PlotSite } from '../../../src/skills/farm/plot.ts';
import { FarmPlotJob, fenceItems, hoeCarried, type PlotJobDeps } from '../../../src/skills/farm/setup.ts';
import { FarmChore, FARM_IDLE_MS, hungryRipeOf, ripeMinOf, type FarmChoreDeps } from '../../../src/tasks/process/farm-new.ts';
import { commonLog, fenceKind, fencePlanks, fieldCount, mixedFence, parseFarmNew, plotSizeAt, woodCarried, woodKindsOfFences } from '../../../src/chat/commands-farm-new.ts';
import type { BlockInfo, Vec3 } from '../../../src/world/types.ts';

const b = (name: string, solid = false, states: Record<string, unknown> = {}): BlockInfo => ({ name, stateId: 0, states, hardness: solid ? 1 : 0, solid, boxes: solid ? [[0, 0, 0, 1, 1, 1]] : [] });
const AIR = b('air');
const GRASS = b('grass_block', true);
const STONE = b('stone', true);
const WATER = b('water', false, { liquid_depth: 0 });
const FARMLAND = b('farmland', true);
const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`;

/** Flat grass at y 64 (stone under), air over it; `cells` override. */
function world(cells: Record<string, BlockInfo> = {}, ground = 64): (p: Vec3) => BlockInfo {
  return (p) => cells[key(p)] ?? (p.y < ground ? STONE : p.y === ground ? GRASS : AIR);
}
const home = { x: 0.5, y: 65, z: 0.5 };

describe('the plot site (Track E6)', () => {
  it('flat grass: the nearest 9x9 site clears the home gap, waters from the middle, the gate faces home', () => {
    const s = findPlotSite(world(), home, { n: 9 }) as PlotSite;
    expect('reason' in s).toBe(false);
    expect(s.y).toBe(64);
    expect(s.soil).toHaveLength(80);
    expect(s.rim).toHaveLength(40);
    // no plot cell (rim included) within 3 of home
    const cells = [...s.soil, s.water, ...s.rim];
    expect(cells.every((c) => Math.max(Math.abs(c.x), Math.abs(c.z)) > 3)).toBe(true);
    // the gate is on the rim, on the side facing home
    expect(onRim(s.water, 9, s.gate)).toBe(true);
    expect(Math.hypot(s.gate.x, s.gate.z)).toBeLessThan(Math.hypot(s.water.x, s.water.z));
    expect(s.watered).toBe(false);
    expect(s.farmland).toBe(0);
  });

  it('plants on the soil are listed to dig first; a log over a cell moves the site', () => {
    const at = { x: 9, y: 64, z: 0 };
    const grass = b('short_grass');
    const ok = checkSite(world({ '10,65,1': grass }), at, 9, { n: 9 }, home) as PlotSite;
    expect(typeof ok).toBe('object');
    expect(ok.covers).toContainEqual({ x: 10, y: 65, z: 1 });
    expect(checkSite(world({ '10,65,1': b('oak_log', true) }), at, 9, { n: 9 }, home)).toBe('covered');
  });

  it('soil a hoe cannot till, a built block, no floor under the water, a rim over a drop all fail', () => {
    const at = { x: 9, y: 64, z: 0 };
    expect(checkSite(world({ '10,64,1': b('sand', true) }), at, 9, { n: 9 }, home)).toBe('soil');
    expect(checkSite(world({ '10,64,1': b('oak_planks', true) }), at, 9, { n: 9, built: (n) => n.endsWith('_planks') }, home)).toBe('built');
    expect(checkSite(world({ '9,63,0': AIR }), at, 9, { n: 9 }, home)).toBe('no_floor');
    expect(checkSite(world({ '14,64,0': AIR }), at, 9, { n: 9 }, home)).toBe('rim');
  });

  it('a farm set up before still fits: farmland, crops, water and its fence', () => {
    const at = { x: 9, y: 64, z: 0 };
    const cells: Record<string, BlockInfo> = { '9,64,0': WATER };
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) if (dx || dz) cells[`${9 + dx},64,${dz}`] = FARMLAND;
    cells['10,65,1'] = b('wheat', false, { growth: 3 });
    // the server's fence: boxes but not `solid` (no full block); the again-run on the test server read it as `rim`
    for (let i = -5; i <= 5; i++) cells[`${9 + i},65,5`] = { ...b('oak_fence', true), solid: false };
    cells['9,65,-5'] = { ...b('fence_gate', true), solid: false };
    const s = checkSite(world(cells), at, 9, { n: 9 }, home) as PlotSite;
    expect(typeof s).toBe('object');
    expect(s.farmland).toBe(80);
    expect(s.watered).toBe(true);
    expect(s.covers).not.toContainEqual({ x: 10, y: 65, z: 1 });
    expect(s.rim.length).toBe(40 - 12); // the 11 posts and the gate stand
  });

  it('not the bot own base: no plot cell within protectRadius + 2 of home', () => {
    const s = findPlotSite(world(), home, { n: 5, protect: { home, radius: 10 }, range: 30 }) as PlotSite;
    expect('reason' in s).toBe(false);
    for (const c of [...s.soil, ...s.rim]) expect(Math.hypot(c.x + 0.5 - home.x, c.z + 0.5 - home.z)).toBeGreaterThan(12);
    const none = findPlotSite(world(), home, { n: 5, protect: { home, radius: 10 }, range: 8 });
    expect('reason' in none && none.why.protected).toBeGreaterThan(0);
    expect(siteWhyText({ protected: 5, soil: 9, near_home: 99 })).toBe('not grass or dirt 9, inside the base (protectRadius) 5');
  });

  it('the own base: only a bed, a table, a furnace and the farm own fence near home', () => {
    const water = { x: 9, y: 64, z: 0 };
    const fence = { p: { x: 14, y: 65, z: 0 }, name: 'oak_fence' };
    expect(ownBase([{ p: { x: 1, y: 65, z: 0 }, name: 'bed' }, { p: { x: 2, y: 65, z: 0 }, name: 'crafting_table' }, fence], (p) => onRim(water, 9, p)).own).toBe(true);
    expect(ownBase([fence]).own).toBe(false);
    const r = ownBase([{ p: { x: 1, y: 65, z: 0 }, name: 'oak_planks' }]);
    expect(r.own).toBe(false);
    expect(r.foreign[0]!.name).toBe('oak_planks');
  });

  it('the own base: a raw copper vein deep under home is no build; planks at the surface or 8 under still are', () => {
    // measured: a fresh world's copper vein, raw_copper_block 21 to 35 under home, pushed the plot 65 blocks out
    const vein = [{ p: { x: 1, y: 39, z: 20 }, name: 'raw_copper_block' }, { p: { x: -4, y: 30, z: 13 }, name: 'raw_copper_block' }];
    expect(ownBase(vein, undefined, 65).own).toBe(true);
    expect(ownBase(vein).own).toBe(false); // with no home height every block counts
    expect(ownBase([...vein, { p: { x: 3, y: 57, z: 0 }, name: 'oak_planks' }], undefined, 65).own).toBe(false);
  });
});

describe('farm new words and helpers (Track E6)', () => {
  it('parses the size: odd, 3 to 9', () => {
    expect(parseFarmNew([])).toEqual({ n: 9 });
    expect(parseFarmNew(['5'])).toEqual({ n: 5 });
    for (const bad of [['4'], ['11'], ['1'], ['x'], ['5', '5']]) expect('error' in parseFarmNew(bad)).toBe(true);
  });

  it('fence kind: wood carried for the whole fence, else the commonest logs round the plot, else the most carried, else oak', () => {
    // the measured case: 3 oak logs carried, a birch wood round the plot, 32 posts: birch (an oak trip there brought birch)
    expect(fenceKind([{ name: 'oak_log', count: 3 }], commonLog(['birch_log', 'birch_log', 'oak_log']), 32)).toBe('birch');
    expect(fenceKind([{ name: 'spruce_log', count: 16 }], 'birch_log', 32)).toBe('spruce');
    expect(fenceKind([{ name: 'spruce_planks', count: 3 }, { name: 'birch_log', count: 2 }], undefined, 15)).toBe('birch');
    expect(fenceKind([], 'dark_oak_log', 15)).toBe('dark_oak');
    expect(fenceKind([], undefined)).toBe('oak');
    expect(fencePlanks(15)).toBe(30); // 5 crafts of 4 planks, 14 sticks (8 planks), 2 planks for the gate
    expect(commonLog([])).toBeUndefined();
    expect(fenceItems('oak')).toEqual({ fence: 'oak_fence', gate: 'fence_gate' });
    expect(fenceItems('spruce')).toEqual({ fence: 'spruce_fence', gate: 'spruce_fence_gate' });
    expect(hoeCarried((n) => (n === 'wooden_hoe' || n === 'iron_hoe' ? 1 : 0))).toBe('iron_hoe');
  });

  it('a mixed wood: the gate from the kind carried most, then each kind posts as far as its planks go', () => {
    // the measured case: 12 birch and 5 oak logs for 35 posts (one kind needs 16 logs): neither makes it all
    const slots = [{ name: 'birch_log', count: 12 }, { name: 'oak_log', count: 5 }, { name: 'oak_planks', count: 2 }];
    expect(woodCarried(slots)).toEqual([['birch', 48], ['oak', 22]]);
    expect(woodCarried(slots).some(([, p]) => p >= fencePlanks(35))).toBe(false);
    // birch: 48 - 4 for the gate = 44, 8 crafts, 24 posts; oak: 22, 4 crafts, 12 posts, 11 wanted
    expect(mixedFence(slots, 35, true)).toEqual([
      { item: 'birch_fence_gate', n: 1 },
      { item: 'birch_fence', n: 24 },
      { item: 'oak_fence', n: 11 },
    ]);
    // posts and a gate carried already count; the targets are what is to be carried
    expect(mixedFence([...slots, { name: 'oak_fence', count: 30 }, { name: 'fence_gate', count: 1 }], 35, true)).toEqual([{ item: 'birch_fence', n: 5 }]);
    expect(mixedFence([{ name: 'oak_planks', count: 4 }], 9, false)).toEqual([]);
    expect(woodKindsOfFences([{ name: 'birch_fence', count: 24 }, { name: 'oak_fence', count: 11 }, { name: 'birch_fence_gate', count: 1 }, null], 'oak')).toEqual({
      fence: 'oak_fence',
      gate: 'fence_gate',
      more: ['birch_fence', 'birch_fence_gate'],
    });
  });

  it('counts ripe crops and reads the plot size off the field', () => {
    const cells: Record<string, BlockInfo> = { '9,64,0': WATER };
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (dx || dz) cells[`${9 + dx},64,${dz}`] = FARMLAND;
    cells['10,65,0'] = b('wheat', false, { growth: 7 });
    cells['8,65,0'] = b('wheat', false, { growth: 2 });
    const at = world(cells);
    expect(fieldCount(at, { x: 9, y: 64, z: 0 }, 5)).toEqual({ ripe: 1, cells: 24, crops: 2 });
    expect(plotSizeAt(at, { x: 9, y: 64, z: 0 })).toBe(5);
  });
});

/** A fake bot on the fake world: goto teleports next to the goal, dig turns a block into air, the hoe tills. */
function fakeBot(cells: Record<string, BlockInfo>, carried: Record<string, number>) {
  const blockAt = world(cells);
  let feet: Vec3 = { x: 0.5, y: 65, z: 0.5 };
  const inv = {
    count: (n: string) => carried[n] ?? 0,
    slots: [],
  };
  const calls: string[] = [];
  const d: PlotJobDeps = {
    world: {
      blockAt,
      find: (pred, o) => {
        const out: Vec3[] = [];
        for (const k of Object.keys(cells)) {
          const [x, y, z] = k.split(',').map(Number) as [number, number, number];
          const p = { x, y, z };
          if (pred(blockAt(p), p) && Math.hypot(x - o.origin.x, y - o.origin.y, z - o.origin.z) <= o.radius) out.push(p);
        }
        return out.slice(0, o.max);
      },
      inventory: inv,
    },
    skills: {
      goto: async (g) => {
        await Promise.resolve();
        if ('p' in g && g.p) feet = { x: g.p.x, y: 65, z: g.p.z };
        return { ok: true };
      },
      dig: async (p) => {
        await Promise.resolve();
        calls.push(`dig ${key(p)}`);
        const was = blockAt(p).name;
        cells[key(p)] = AIR;
        if (was === 'short_grass') carried.wheat_seeds = (carried.wheat_seeds ?? 0) + 1;
        return { ok: true } as never;
      },
      place: async (p, o) => {
        await Promise.resolve();
        calls.push(`place ${key(p)} ${String(o?.item)}`);
        if (o?.item === 'water_bucket' && carried.water_bucket) {
          cells[key(p)] = WATER;
          carried.water_bucket--;
          carried.bucket = (carried.bucket ?? 0) + 1;
        } else if (typeof o?.item === 'string' && carried[o.item]) {
          cells[key(p)] = b(o.item, true);
          carried[o.item] = (carried[o.item] ?? 0) - 1;
        } else return { ok: false, reason: 'no_item' };
        return { ok: true };
      },
      collect: () => Promise.resolve({ ok: true } as never),
    },
    click: async (p, item) => {
      await Promise.resolve();
      calls.push(`click ${key(p)} ${item}`);
      if (item.endsWith('_hoe') && ['grass_block', 'dirt'].includes(blockAt(p).name)) {
        cells[key(p)] = FARMLAND;
        return { ok: true };
      }
      if (item === 'bucket' && blockAt(p).name === 'water') {
        cells[key(p)] = AIR;
        carried.bucket = (carried.bucket ?? 0) - 1;
        carried.water_bucket = 1;
        return { ok: true };
      }
      return { ok: false, reason: 'rejected' };
    },
    farm: {
      start: async () => {
        await Promise.resolve();
        planted.n = 0; // FarmTask.start resets its counters
        for (const [k, v] of Object.entries(cells)) {
          if (v.name !== 'farmland' || !carried.wheat_seeds) continue;
          const [x, y, z] = k.split(',').map(Number) as [number, number, number];
          const up = key({ x, y: y + 1, z });
          if (blockAt({ x, y: y + 1, z }).name === 'air') {
            cells[up] = b('wheat', false, { growth: 0 });
            carried.wheat_seeds--;
            planted.n++;
          }
        }
        return 'done';
      },
      stop: () => undefined,
      get stats() {
        return { planted: planted.n };
      },
    },
    position: () => feet,
    now: () => 0,
  };
  const planted = { n: 0 };
  return { d, calls, cells, carried };
}

describe('the plot job (Track E6)', () => {
  const site = (cells: Record<string, BlockInfo>, n = 3): PlotSite => checkSite(world(cells), { x: 9, y: 64, z: 0 }, n, { n }, home) as PlotSite;

  it('water from a pond, the middle dug and poured, every cell tilled and planted, the fence and gate set', async () => {
    const cells: Record<string, BlockInfo> = { '20,64,0': WATER, '6,65,3': b('short_grass') };
    const s = site(cells);
    const f = fakeBot(cells, { bucket: 1, stone_hoe: 1, wheat_seeds: 8, oak_fence: 15, fence_gate: 1 });
    const job = new FarmPlotJob(s, ['water', 'clear', 'till', 'plant', 'fence']);
    job.fence = fenceItems('oak');
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stop).toBeUndefined();
    expect(job.stats.water).toBe('poured');
    expect(f.cells['9,64,0']!.name).toBe('water');
    expect(job.stats.tilled).toBe(8);
    expect(job.stats.planted).toBe(8);
    expect(job.stats.fenced).toBe(15);
    expect(job.stats.gate).toBe(true);
    expect(f.cells[key(s.gate)]!.name).toBe('fence_gate');
  });

  it('a mixed fence: the posts of one wood, then the other, and the other wood gate', async () => {
    const cells: Record<string, BlockInfo> = {};
    const f = fakeBot(cells, { oak_fence: 10, birch_fence: 5, birch_fence_gate: 1 });
    const job = new FarmPlotJob(site(cells), ['fence']);
    job.fence = { ...fenceItems('oak'), more: ['birch_fence', 'birch_fence_gate'] };
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.fenced).toBe(15);
    expect(job.stats.gate).toBe(true);
    expect(f.carried).toMatchObject({ oak_fence: 0, birch_fence: 0, birch_fence_gate: 0 });
  });

  it('the bot standing on the last free line cell: it steps off and fences it (the place refusal used to spin)', async () => {
    const cells: Record<string, BlockInfo> = {};
    const s = site(cells);
    const f = fakeBot(cells, { oak_fence: 15, fence_gate: 1 });
    const last = s.rim.find((c) => !(c.x === s.gate.x && c.z === s.gate.z))!;
    // every other cell fenced already; the bot stands in the one left
    for (const c of s.rim) if (c !== last && !(c.x === s.gate.x && c.z === s.gate.z)) cells[key(c)] = { ...b('oak_fence', true), solid: false };
    let at: Vec3 = { x: last.x + 0.5, y: 65, z: last.z + 0.5 };
    f.d.position = () => at;
    const place = f.d.skills.place.bind(f.d.skills);
    f.d.skills.place = async (p, o) => (Math.floor(at.x) === p.x && Math.floor(at.z) === p.z ? { ok: false, reason: 'in_body' } : place(p, o));
    const goto = f.d.skills.goto.bind(f.d.skills);
    f.d.skills.goto = async (g, o) => {
      if ('p' in g && g.p) at = { x: g.p.x, y: 65, z: g.p.z };
      return goto(g, o);
    };
    const job = new FarmPlotJob(s, ['fence']);
    job.fence = fenceItems('oak');
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(f.cells[key(last)]!.name).toBe('oak_fence');
    expect(job.stats.gate).toBe(true);
  });

  it('a dig of the middle that times out is tried again (a fresh world plot stayed dry after one)', async () => {
    const cells: Record<string, BlockInfo> = { '20,64,0': WATER };
    const f = fakeBot(cells, { bucket: 1 });
    const dig = f.d.skills.dig.bind(f.d.skills);
    let fails = 1;
    f.d.skills.dig = async (p, o) => (key(p) === '9,64,0' && fails-- > 0 ? ({ ok: false, reason: 'timeout' }) : dig(p, o));
    const job = new FarmPlotJob(site(cells), ['water']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.water).toBe('poured');
  });

  it('a pour read as rejected whose water shows a moment later counts as poured; one that never shows stays dry', async () => {
    const late = (show: boolean) => {
      const cells: Record<string, BlockInfo> = {};
      const f = fakeBot(cells, { water_bucket: 1 });
      const waits: number[] = [];
      f.d.skills.place = async (p) => {
        await Promise.resolve();
        return key(p) === '9,64,0' ? { ok: false, reason: 'rejected' } : { ok: true };
      };
      f.d.wait = async (ms) => {
        await Promise.resolve();
        waits.push(ms);
        if (show && waits.length === 2) cells['9,64,0'] = WATER; // the server's word comes about 1 s later
      };
      return { f, cells, waits };
    };
    const a = late(true);
    const wet = new FarmPlotJob(site(a.cells), ['water']);
    expect(await wet.run(a.f.d, () => false)).toBe(true);
    expect(wet.stats.water).toBe('poured');
    expect(a.waits).toEqual([500, 500]);
    const z = late(false);
    const dry = new FarmPlotJob(site(z.cells), ['water']);
    expect(await dry.run(z.f.d, () => false)).toBe(true);
    expect(dry.stats.water).toBe('dry');
    expect(z.waits).toHaveLength(4);
  });

  it('no water within 48: a pond within 96 still fills the bucket; none within 96 leaves the plot dry', async () => {
    const far: Record<string, BlockInfo> = { '80,64,0': WATER };
    const f = fakeBot(far, { bucket: 1 });
    const job = new FarmPlotJob(site(far), ['water']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.water).toBe('poured');
    expect(f.calls).toContain('click 80,64,0 bucket');
    const tooFar: Record<string, BlockInfo> = { '120,64,0': WATER };
    const g = fakeBot(tooFar, { bucket: 1 });
    const dry = new FarmPlotJob(site(tooFar), ['water']);
    expect(await dry.run(g.d, () => false)).toBe(true);
    expect(dry.stats.water).toBe('dry');
  });

  it('no water near: the plot stays dry, tilled for the seeds carried and planted', async () => {
    const cells: Record<string, BlockInfo> = {};
    const f = fakeBot(cells, { bucket: 1, wooden_hoe: 1, wheat_seeds: 2 });
    const job = new FarmPlotJob(site(cells), ['water', 'till', 'plant']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.water).toBe('dry');
    expect(job.stats.tilled).toBe(2); // 2 seeds: 2 cells (the middle stays grass)
    expect(job.stats.planted).toBe(2);
  });

  it('a dry plot: only as many cells tilled as there are seeds (bare dry farmland turns back to dirt)', async () => {
    const cells: Record<string, BlockInfo> = {};
    const f = fakeBot(cells, { stone_hoe: 1, wheat_seeds: 3 });
    const job = new FarmPlotJob(site(cells), ['till', 'plant']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stats.tilled).toBe(3);
    expect(job.stats.planted).toBe(3);
  });

  it('no hoe: the till step ends the job with the reason', async () => {
    const cells: Record<string, BlockInfo> = {};
    const f = fakeBot(cells, { wheat_seeds: 5 });
    const job = new FarmPlotJob(site(cells), ['till', 'plant']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stop).toMatch(/^no hoe left/);
    expect(job.phase).toBe('till');
  });

  it('no seed from the grass near: the job ends with the reason; a pause keeps the phase', async () => {
    const cells: Record<string, BlockInfo> = {};
    const f = fakeBot(cells, { stone_hoe: 1 });
    const job = new FarmPlotJob(site(cells), ['seeds', 'till']);
    expect(await job.run(f.d, () => false)).toBe(true);
    expect(job.stop).toMatch(/^no seeds/);
    const grass: Record<string, BlockInfo> = { '12,65,2': b('short_grass'), '6,65,-2': b('short_grass') };
    const g = fakeBot(grass, { stone_hoe: 1 });
    const j2 = new FarmPlotJob(site(grass), ['seeds', 'till']);
    let n = 0;
    expect(await j2.run(g.d, () => ++n > 1)).toBe(false);
    expect(j2.phase).toBe('seeds');
    expect(await j2.run(g.d, () => false)).toBe(true);
    expect(j2.stats.grassBroken).toBe(2);
    expect(j2.stats.seedsGot).toBe(2);
  });

  it('seeds with the bot far off (the hoe log trip): it walks to the plot before it looks for grass', async () => {
    // measured: after a log trip 120 off, the grass round the plot was not loaded and the step said `0 grass broken`
    const grass: Record<string, BlockInfo> = { '12,65,2': b('short_grass') };
    const g = fakeBot(grass, { stone_hoe: 1 });
    let at: Vec3 = { x: 130.5, y: 65, z: 0.5 };
    const goals: Vec3[] = [];
    const goto = g.d.skills.goto.bind(g.d.skills);
    g.d.position = () => at;
    g.d.skills.goto = async (goal, o) => {
      if ('p' in goal && goal.p) {
        goals.push(goal.p);
        at = { x: goal.p.x, y: 65, z: goal.p.z };
      }
      return goto(goal, o);
    };
    const job = new FarmPlotJob(site(grass), ['seeds']);
    expect(await job.run(g.d, () => false)).toBe(true);
    expect(goals[0]).toEqual({ x: 9.5, y: 65, z: 0.5 });
    expect(job.stats.grassBroken).toBe(1);
  });
});

function chore(o: Partial<{ farmFood: boolean; foodMin: number; day: boolean; users: number; points: number; ripe: number; cells: number; wheat: number; far: boolean; foodBusy: boolean }> = {}) {
  const s = { farmFood: true, foodMin: 10, day: true, users: 0, points: 30, ripe: 0, cells: 80, wheat: 0, far: false, foodBusy: false, ...o };
  let t = 0;
  const stats = { harvested: 0, planted: 0 };
  const breads: number[] = [];
  const d: FarmChoreDeps = {
    processes: { userProcesses: () => Array.from({ length: s.users }) } as never,
    settings: { get: ((k: string) => (k === 'farmFood' ? s.farmFood : s.foodMin)) as never },
    farm: () => ({ water: { x: 9, y: 64, z: 0 }, n: 9 }),
    position: () => (s.far ? { x: 200, y: 65, z: 0 } : { x: 0, y: 65, z: 0 }),
    isDay: () => s.day,
    foodPoints: () => s.points,
    field: () => ({ ripe: s.ripe, cells: s.cells }),
    wheat: () => s.wheat,
    foodBusy: () => s.foodBusy,
    farmer: {
      start: async () => {
        await Promise.resolve();
        stats.harvested = s.ripe; // FarmTask.start resets its counters
        stats.planted = s.ripe;
        s.wheat += s.ripe;
        s.ripe = 0;
        return 'done';
      },
      stop: () => undefined,
      stats,
    },
    bread: async () => {
      await Promise.resolve();
      const n = Math.floor(s.wheat / 3);
      s.wheat -= n * 3;
      breads.push(n);
      return n;
    },
    cancel: () => undefined,
    now: () => t,
  };
  const c = new FarmChore(d);
  return { c, d, s, breads, tick: (ms: number) => (t += ms) };
}

describe('the farm chore (Track E6)', () => {
  it('is not named `farm`: that name is `!farm`\'s process, found by name (farm-process e2e took the chore for it)', () => {
    expect(chore().c.name).not.toBe('farm');
    expect(chore().c.name).not.toBe('farmnew');
  });

  it('starts at 16 ripe (a quarter of a small field), not below while fed; off, by night or under a command it waits', () => {
    expect(chore({ ripe: 16 }).c.wants()).toBe(true);
    expect(chore({ ripe: 15 }).c.wants()).toBe(false);
    expect(chore({ ripe: 2, cells: 8 }).c.wants()).toBe(true);
    // a watered 9 x 9 with 21 crops on its 80 tilled cells (a fresh world): a quarter of the crops, 6, starts it
    expect(ripeMinOf({ cells: 80, crops: 21 })).toBe(6);
    expect(ripeMinOf({ cells: 80 })).toBe(16);
    expect(ripeMinOf({ cells: 80, crops: 0 })).toBe(1);
    expect(chore({ ripe: 16, farmFood: false }).c.wants()).toBe(false);
    expect(chore({ ripe: 16, day: false }).c.wants()).toBe(false);
    expect(chore({ ripe: 16, users: 1 }).c.wants()).toBe(false);
    expect(chore({ ripe: 16, foodBusy: true }).c.wants()).toBe(false);
    expect(chore({ ripe: 16, far: true }).c.wants()).toBe(false);
  });

  it('food short: the ripe crops and wheat for a loaf start it; it harvests and bakes, then waits', async () => {
    // one ripe crop used to start it: a fresh world's bot walked 25 blocks for 1 wheat and no bread, the hunt held back
    expect(chore({ points: 4, ripe: 1 }).c.wants()).toBe(false);
    expect(chore({ points: 4, ripe: 2 }).c.wants()).toBe(false);
    expect(chore({ points: 4, ripe: 3 }).c.wants()).toBe(true);
    expect(chore({ points: 4, ripe: 1, wheat: 2 }).c.wants()).toBe(true);
    expect(hungryRipeOf(0)).toBe(3);
    expect(hungryRipeOf(5)).toBe(1);
    const b2 = chore({ points: 4, wheat: 7 });
    expect(b2.c.wants()).toBe(true);
    expect(b2.c.canFeed()).toBe(true);
    const k = chore({ points: 4, ripe: 20, wheat: 1 });
    expect(k.c.wants()).toBe(true);
    k.c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(k.breads).toEqual([7]);
    expect(k.c.stats.harvested).toBe(20);
    expect(k.c.running).toBe(false);
    // nothing harvested the next time: a long wait
    const e = chore({ points: 4, wheat: 3 });
    e.c.wants();
    e.c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(e.c.nextTry).toBe(FARM_IDLE_MS);
  });

  it('drops in the middle water: picked up from beside it, then the farm worked again to plant the seeds', async () => {
    const k = chore({ ripe: 24 });
    let starts = 0;
    const start = k.d.farmer.start.bind(k.d.farmer);
    k.d.farmer.start = async (o) => {
      starts++;
      return start(o);
    };
    const picks: Vec3[] = [];
    k.d.pickMiddle = async (w) => {
      await Promise.resolve();
      picks.push(w);
      k.s.wheat += 2; // two wheat that had floated in the water
      return 3;
    };
    expect(k.c.wants()).toBe(true);
    k.c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(picks).toEqual([{ x: 9, y: 64, z: 0 }]);
    expect(starts).toBe(2);
    expect(k.breads).toEqual([8]);
  });

  it('nothing to give: the food chore hunts (canFeed false)', () => {
    expect(chore({ points: 4 }).c.canFeed()).toBe(false);
    expect(chore({ points: 4, ripe: 1, farmFood: false }).c.canFeed()).toBe(false);
    expect(chore({ points: 4, ripe: 1 }).c.canFeed()).toBe(false); // 1 wheat makes no loaf: the hunt goes
    expect(chore({ points: 4, ripe: 3 }).c.canFeed()).toBe(true);
    expect(chore({ points: 4, ripe: 2, wheat: 1 }).c.canFeed()).toBe(true);
  });
});
