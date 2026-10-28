// Track AB (docs/pathfinding.md "Compute"): the planner worker. A fixture World (recorded login, real
// registry, generated subchunks: hills, trees, water, lava, stairs, slabs, doors, fences, glass and an
// unknown runtime id) is forwarded to a MirrorWorld; the mirror must classify cells like the
// main thread's grid (loaded columns, after block updates and section re-sends, cached columns after
// an unload), a real worker thread must plan the same cost as the in-thread planner, and the navigator
// must walk an interim answer, splice in the final one, and fall back in-thread when the worker dies.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import { BotSkills } from '../../../src/skills/index.ts';
import { findPath, type PathResult } from '../../../src/skills/nav/astar.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { PlannerClient, corridor, type PlannerWorker, type WorkerPlanOptions } from '../../../src/skills/nav/worker.ts';
import { MirrorWorld, type MirrorOp } from '../../../src/skills/nav/worker-grid.ts';
import { classify } from '../../../src/skills/terrain/classify.ts';
import { worldSource } from '../../../src/skills/terrain/query.ts';
import { WorldCache } from '../../../src/world/cache/index.ts';
import { World } from '../../../src/world/index.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { encodeSubChunk, fillSection, readyRegistry, recordedLogin, ReplaySource } from '../world/helpers.ts';
import { harness } from './fakes.ts';

const reg = readyRegistry();
const rid = (name: string, states?: Record<string, unknown>): number => {
  const s = reg.stateIdOf(name, states);
  if (s === undefined) throw new Error(`no state ${name} ${JSON.stringify(states)}`);
  return reg.runtimeIdOf(s);
};
const AIR = rid('air');
const STONE = rid('stone');
const DIRT = rid('dirt');
const GRASS = rid('grass_block');
const LOG = rid('oak_log', { pillar_axis: 'y' });
const LEAVES = rid('oak_leaves');
const WATER = rid('water');
const LAVA = rid('lava');
const SLAB = rid('smooth_stone_slab');
const GLASS = rid('glass');
const FENCE = rid('oak_fence');
const STAIRS = [0, 1, 2, 3].map((d) => rid('oak_stairs', { weirdo_direction: d }));
const DOOR_LOW = rid('wooden_door', { upper_block_bit: 0, open_bit: 0 });
const DOOR_UP = rid('wooden_door', { upper_block_bit: 1, open_bit: 0 });
const LADDER = rid('ladder', { facing_direction: 3 }); // Track AJ: a ladder tower
/** A runtime id the registry does not know (a block newer than the data): a 1.5-high obstacle. */
const UNKNOWN_RID = 123456789;

const C0 = -3;
const C1 = 2;
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const hash = (x: number, z: number): number => {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Ground height of column (X, Z) in the hills world. */
const groundY = (x: number, z: number): number => -58 + Math.round(3 * Math.sin(x / 7) + 2 * Math.cos(z / 5));

/** The hills world: stone, dirt, grass; trees, a pond, lava, stairs, slabs, a door, fences, glass, unknown blocks. */
function hills(x: number, y: number, z: number): number {
  const g = groundY(x, z);
  const r = hash(x, z);
  if (x >= -10 && x <= -6 && z >= 4 && z <= 8) return y <= g - 1 ? STONE : y <= g ? WATER : AIR; // pond
  if (x === 12 && z >= -4 && z <= -2) return y < g ? STONE : y === g ? LAVA : AIR;
  // Track AJ: an 8-high stone pillar with a ladder on its south face (the only way onto its top)
  if (x === 21 && z === -31 && y > g && y <= g + 8) return STONE;
  if (x === 21 && z === -30 && y > g && y <= g + 8) return LADDER;
  if (y < g - 2) return STONE;
  if (y < g) return DIRT;
  if (y === g) return GRASS;
  if (y === g + 1) {
    if (r < 0.03) return SLAB;
    if (r < 0.05) return STAIRS[Math.floor(r * 1000) % 4]!;
    if (r < 0.06) return FENCE;
    if (r < 0.065) return GLASS;
    if (r < 0.07) return UNKNOWN_RID;
    if (x === 4 && z === 4) return DOOR_LOW;
  }
  if (x === 4 && z === 4 && y === g + 2) return DOOR_UP;
  // trees on a grid
  if (x % 13 === 0 && z % 11 === 0 && x !== 0) {
    if (y > g && y <= g + 4) return LOG;
  }
  for (const [tx, tz] of [
    [13, 11],
    [-13, -11],
    [13, -22],
  ] as const) {
    if (y >= g + 3 && y <= g + 5 && Math.abs(x - tx) <= 2 && Math.abs(z - tz) <= 2 && !(x === tx && z === tz)) return LEAVES;
  }
  return AIR;
}

/** Flat floor at y -61 with 3 staggered 3-high walls (x = -24, 0, 24) open at alternating ends (z ends 30). */
function baffles(x: number, y: number, z: number): number {
  if (y < -61) return STONE;
  if (y === -61) return GRASS;
  if (y > -58) return AIR;
  if ((x === -24 || x === 24) && z >= -48 && z <= 20) return STONE;
  if (x === 0 && z >= -20 && z <= 47) return STONE;
  return AIR;
}

/** A World fed by hand: columns C0..C1 squared, 4 sections (y -64 .. -1) from a block function. */
function fixtureWorld(blocks: (x: number, y: number, z: number) => number, opts: { cacheDir?: string } = {}) {
  const src = new ReplaySource();
  const world = new World(src, { logger: silentLogger, defer: (fn) => fn() });
  const { startGame, itemRegistry } = recordedLogin();
  src.emit('start_game', startGame);
  src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
  src.emit('network_chunk_publisher_update', { coordinates: { x: 0, y: 0, z: 0 }, radius: 128, saved_chunks: [] });
  let cache: WorldCache | undefined;
  if (opts.cacheDir) {
    cache = new WorldCache({ dir: opts.cacheDir, flushIntervalMs: 0, logger: silentLogger });
    cache.attach(world);
  }
  const sendColumn = (cx: number, cz: number) => {
    src.emit('level_chunk', { x: cx, z: cz, dimension: 0, sub_chunk_count: 0, highest_subchunk_count: 4, cache_enabled: false, blobs: [], payload: Buffer.alloc(0) });
    src.emit('subchunk', {
      cache_enabled: false,
      dimension: 0,
      origin: { x: cx, y: -4, z: cz },
      entries: [0, 1, 2, 3].map((dy) => ({
        dx: 0,
        dy,
        dz: 0,
        result: 'success',
        payload: encodeSubChunk([fillSection((lx, ly, lz) => blocks(cx * 16 + lx, (dy - 4) * 16 + ly, cz * 16 + lz))], { y: dy - 4 }),
      })),
    });
  };
  for (let cx = C0; cx <= C1; cx++) for (let cz = C0; cz <= C1; cz++) sendColumn(cx, cz);
  const setBlock = (p: Vec3, r: number) => src.emit('update_block', { position: p, block_runtime_id: r, flags: {}, layer: 0 });
  return { src, world, cache, sendColumn, setBlock };
}

/** A worker stand-in in this thread: ops are structured-cloned into `mirror` (what postMessage does). */
function fakeWorker(mirror: MirrorWorld, o: { crashAfterReady?: boolean } = {}): PlannerWorker {
  const fns = new Map<string, ((v: unknown) => void)[]>();
  const emit = (ev: string, v: unknown) => {
    for (const fn of fns.get(ev) ?? []) fn(v);
  };
  return {
    postMessage(m) {
      const c = structuredClone(m) as { t: string; ops?: MirrorOp[] };
      if (c.t === 'ops') for (const op of c.ops!) mirror.apply(op);
    },
    on(ev, fn) {
      fns.set(ev, [...(fns.get(ev) ?? []), fn]);
      if (ev === 'exit')
        setTimeout(() => {
          emit('message', { t: 'ready' });
          if (o.crashAfterReady) setTimeout(() => emit('error', new Error('boom')), 20);
        }, 1);
    },
    terminate() {},
  };
}

async function until(fn: () => boolean, ms = 10_000): Promise<void> {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > ms) throw new Error('timed out');
    await sleep(2);
  }
}

/** Every planner-relevant fact of a cell: the block, its class, stand / standThrough, crossing, the sky column. */
function cellFacts(grid: NavGrid, x: number, y: number, z: number): string {
  const b = grid.source.blockAt(x, y, z);
  const c = b && classify(b);
  return JSON.stringify([
    b?.name,
    b?.stateId,
    b?.states,
    c?.name,
    c?.top,
    c?.floor,
    c?.unknown,
    grid.stand(x, y, z),
    grid.standThrough(x, y, z),
    grid.crossing(x, y, z, 0),
    grid.crossing(x, y, z, 2),
    grid.skyTop(x, z),
    grid.source.columnTop?.(x, z),
  ]);
}

function randomCells(n: number, seed: number, area: { x0: number; x1: number; z0: number; z1: number }): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const x = area.x0 + Math.floor(hash(i, seed) * (area.x1 - area.x0 + 1));
    const z = area.z0 + Math.floor(hash(seed, i) * (area.z1 - area.z0 + 1));
    const y = groundY(x, z) - 2 + Math.floor(hash(i + seed, i) * 8);
    out.push({ x, y, z });
  }
  return out;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('planner worker: the mirror', () => {
  it('classifies 200 random cells like the in-thread grid: loaded, after block updates and re-sent sections, cached after an unload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-navworker-'));
    dirs.push(dir);
    const F = fixtureWorld(hills, { cacheDir: dir });
    const mirror = new MirrorWorld();
    const client = new PlannerClient(F.world, { spawn: () => fakeWorker(mirror) });
    client.start();
    await until(() => client.ready);
    const area = { x0: C0 * 16, x1: C1 * 16 + 15, z0: C0 * 16, z1: C1 * 16 + 15 };
    const cells = randomCells(200, 1, area);
    const compare = (label: string, list: Vec3[]) => {
      const main = new NavGrid(worldSource(F.world));
      const copy = new NavGrid(mirror.source);
      let bad = 0;
      for (const p of list) {
        const a = cellFacts(main, p.x, p.y, p.z);
        const b = cellFacts(copy, p.x, p.y, p.z);
        if (a !== b) {
          bad++;
          if (bad < 4) console.log(`${label} ${p.x},${p.y},${p.z}\n main   ${a}\n mirror ${b}`);
        }
      }
      expect(bad, label).toBe(0);
    };
    compare('loaded', cells);
    // the features are in the sample (doors, stairs, unknown blocks, water ...)
    const names = new Set([...cells, { x: 4, y: groundY(4, 4) + 1, z: 4 }].map((p) => F.world.blockAt(p)?.name));
    expect(names.has('stone') && names.has('grass_block') && names.has('air')).toBe(true);

    // block updates (a wall, an opened door, an unknown block, a log removed) and a re-sent column
    const g = groundY(4, 4);
    F.setBlock({ x: 4, y: g + 1, z: 4 }, rid('wooden_door', { upper_block_bit: 0, open_bit: 1 }));
    for (let z = -6; z <= 6; z++) F.setBlock({ x: 2, y: groundY(2, z) + 1, z }, STONE);
    F.setBlock({ x: 5, y: groundY(5, 5) + 1, z: 5 }, UNKNOWN_RID);
    F.setBlock({ x: 13, y: groundY(13, 11) + 2, z: 11 }, AIR);
    F.setBlock({ x: 1, y: -20, z: 1 }, STONE); // into an all-air section
    F.sendColumn(1, 1);
    await flush();
    const touched = [{ x: 4, y: g + 1, z: 4 }, { x: 4, y: g + 2, z: 4 }, { x: 5, y: groundY(5, 5) + 1, z: 5 }, { x: 13, y: groundY(13, 11) + 2, z: 11 }, { x: 1, y: -20, z: 1 }];
    for (let z = -6; z <= 6; z++) touched.push({ x: 2, y: groundY(2, z) + 1, z }, { x: 2, y: groundY(2, z) + 2, z });
    compare('after updates', [...cells, ...touched]);
    expect(client.stats.blocks).toBeGreaterThanOrEqual(15);

    // unload x >= 0 (they go into the cache), send the cached columns, compare stand-ins
    F.src.emit('network_chunk_publisher_update', { coordinates: { x: -40, y: 0, z: 0 }, radius: 16, saved_chunks: [] });
    await flush();
    expect(F.world.chunks.isLoaded(1, 1)).toBe(false);
    expect(F.cache!.has(1, 1)).toBe(true);
    expect(mirror.source.blockAt(20, -60, 20)).toBeUndefined();
    // a corridor towards the unloaded side covers its columns (within 1 chunk of the line)
    const cols = corridor({ x: -40, z: 0 }, { type: 'block', p: { x: 40, y: -60, z: 0 } });
    expect(cols.some(([cx, cz]) => cx === 2 && cz === 1)).toBe(true);
    expect(client.pumpCache(cols)).toBe(true);
    await flush();
    expect(mirror.cacheCount).toBeGreaterThan(0);
    compare('cached', randomCells(200, 2, { x0: 0, x1: C1 * 16 + 15, z0: -16, z1: 31 }));
    // the rest of the unloaded columns
    const all: number[][] = [];
    for (let cx = 0; cx <= C1; cx++) for (let cz = C0; cz <= C1; cz++) all.push([cx, cz]);
    client.pumpCache(all);
    await flush();
    compare('cached, all', randomCells(200, 3, { x0: 0, x1: C1 * 16 + 15, z0: C0 * 16, z1: C1 * 16 + 15 }));
    client.dispose();
  });
});

describe('planner worker: a real worker thread', () => {
  it('plans the same cost as the in-thread planner for 20 random start / goal pairs (and after a wall is built)', async () => {
    const F = fixtureWorld(hills);
    const client = new PlannerClient(F.world);
    client.start();
    await until(() => client.ready, 20_000);
    const spec: WorkerPlanOptions = { maxNodes: 300_000, maxMs: 20_000, allowBreak: false, allowPlace: false, allowOpen: true };
    const main = () => new NavGrid(worldSource(F.world));
    const stands = (p: Vec3) => {
      const f = main().stand(p.x, p.y, p.z);
      return f !== undefined && !Number.isNaN(f);
    };
    const pick = (i: number): Vec3 => {
      for (let k = 0; ; k++) {
        const x = C0 * 16 + Math.floor(hash(i, k + 7) * 96);
        const z = C0 * 16 + Math.floor(hash(k + 7, i) * 96);
        const p = { x, y: groundY(x, z) + 1, z };
        if (stands(p)) return p;
      }
    };
    const viaWorker = async (start: Vec3, goal: Vec3): Promise<PathResult> => {
      const s = client.search('main', start, { type: 'block', p: goal }, spec, 0);
      let r: PathResult | undefined;
      while (!(r = s.step())) {
        if (s.failed) throw new Error('worker search failed');
        await sleep(1);
      }
      return r;
    };
    const lines: string[] = [];
    let same = 0;
    for (let i = 0; i < 20; i++) {
      const a = pick(2 * i);
      const b = pick(2 * i + 1);
      const t = findPath(main(), a, { type: 'block', p: b }, { maxNodes: 300_000, maxMs: 20_000, allowOpen: true });
      const w = await viaWorker(a, b);
      lines.push(`${a.x},${a.y},${a.z} -> ${b.x},${b.y},${b.z}: thread ${t.status} ${t.cost.toFixed(2)} (${t.expanded}e) worker ${w.status} ${w.cost.toFixed(2)} (${w.expanded}e)`);
      expect(w.status, lines.at(-1)).toBe(t.status);
      expect(Math.abs(w.cost - t.cost), lines.at(-1)).toBeLessThanOrEqual(1);
      if (w.path.length === t.path.length) same++;
    }
    // Track AJ: up the ladder onto the pillar (climb moves in both planners)
    {
      const a = { x: 21, y: groundY(21, -28) + 1, z: -28 };
      const b = { x: 21, y: groundY(21, -31) + 9, z: -31 };
      const t = findPath(main(), a, { type: 'block', p: b }, { maxNodes: 300_000, maxMs: 20_000, allowOpen: true });
      const w = await viaWorker(a, b);
      lines.push(`ladder: thread ${t.status} ${t.cost.toFixed(2)} worker ${w.status} ${w.cost.toFixed(2)}`);
      expect(t.status).toBe('found');
      expect(t.path.some((n) => n.move === 'climb')).toBe(true);
      expect(w.status).toBe(t.status);
      expect(Math.abs(w.cost - t.cost)).toBeLessThanOrEqual(1);
    }
    // a wall across the middle, built after the snapshot: both see it
    for (let z = C0 * 16; z <= C1 * 16 + 15; z++) for (let dy = 1; dy <= 3; dy++) if (z !== 30) F.setBlock({ x: 6, y: groundY(6, z) + dy, z }, STONE);
    await flush();
    const a = pick(100);
    const b = { x: 20, y: groundY(20, -20) + 1, z: -20 };
    const t = findPath(main(), a, { type: 'block', p: b }, { maxNodes: 300_000, maxMs: 20_000, allowOpen: true });
    const w = await viaWorker(a, b);
    lines.push(`after the wall: thread ${t.status} ${t.cost.toFixed(2)} worker ${w.status} ${w.cost.toFixed(2)}; same path length ${same}/20`);
    console.log(`[nav-worker] ${lines.join('\n  ')}\n  stats ${JSON.stringify(client.stats)}`);
    expect(w.status).toBe(t.status);
    expect(Math.abs(w.cost - t.cost)).toBeLessThanOrEqual(1);
    client.dispose();
  }, 60_000);

  it('the navigator walks the interim answer, splices in the final one, and plannerThreads 0 plans in-thread', async () => {
    const F = fixtureWorld(baffles);
    const runs: { threads: number; ok: boolean; plans: string; upgrades: number; ticks: number }[] = [];
    for (const threads of [1, 0]) {
      const h = harness({ x: -40.5, y: -60, z: 0.5 });
      // mainMs 2: the interim answer comes after 2 ms of search, long before the final one
      const skills = new BotSkills({ loop: h.loop, world: F.world, mainMs: 2 });
      skills.nav.attachPlanner(F.world, { threads: () => threads });
      if (threads) await until(() => skills.nav.planner!.ready, 20_000);
      h.conn.tick(3);
      let result: { ok: boolean } | undefined;
      void skills.goto({ type: 'block', p: { x: 40, y: -60, z: 0 } }, { timeoutTicks: 3000 }).then((r) => (result = r));
      let t = 0;
      while (skills.nav.busy && t < 3000) {
        h.conn.tick();
        await sleep(t % 4 === 0 ? 1 : 0);
        t++;
      }
      const rep = skills.nav.lastReport!;
      runs.push({ threads, ok: result?.ok ?? false, plans: rep.plans.map((p) => `${p.reason}${p.interim ? '(interim)' : p.upgrade ? '(final)' : ''}:${p.status}/${p.nodes}n/${p.expanded}e/${p.via}`).join(' '), upgrades: rep.upgrades ?? 0, ticks: rep.ticks });
      skills.dispose();
    }
    console.log(`[nav-worker] baffles: ${runs.map((r) => `threads ${r.threads}: ${r.ok ? 'ok' : 'failed'} in ${r.ticks} ticks, upgrades ${r.upgrades}, plans ${r.plans}`).join('\n  ')}`);
    const [w, i] = runs as [(typeof runs)[0], (typeof runs)[0]];
    expect(w.ok).toBe(true);
    expect(i.ok).toBe(true);
    expect(w.plans).toContain('(interim)');
    expect(w.plans).toContain('(final):found');
    expect(w.upgrades).toBeGreaterThanOrEqual(1);
    expect(i.plans).not.toContain('worker');
  }, 60_000);

  it('a worker crash is logged once, its search fails (the navigator plans in-thread) and the worker restarts', async () => {
    const F = fixtureWorld(hills);
    const mirror = new MirrorWorld();
    const warnings: string[] = [];
    const log = { ...silentLogger, warn: (m: string) => warnings.push(m) };
    let spawned = 0;
    const client = new PlannerClient(F.world, {
      logger: log,
      spawn: () => {
        spawned++;
        return fakeWorker(mirror, { crashAfterReady: spawned === 1 });
      },
    });
    client.start();
    await until(() => client.ready);
    const s = client.search('main', { x: 1, y: groundY(1, 1) + 1, z: 1 }, { type: 'block', p: { x: 20, y: -60, z: 20 } }, { maxNodes: 1000, maxMs: 100, allowBreak: false, allowPlace: false, allowOpen: false }, 0);
    s.step();
    await until(() => client.stats.crashes === 1);
    expect(s.failed).toBe(true);
    expect(s.step()).toBeUndefined();
    await until(() => spawned === 2 && client.ready, 5000);
    expect(warnings.filter((w) => w.includes('crashed'))).toHaveLength(1);
    client.dispose();
  });

  it('Track AX: plans out of a chest-floored hole (a jump from feet +0.95) and from a dirt path through a door like the in-thread planner', async () => {
    const CHEST = rid('chest', { 'minecraft:cardinal_direction': 'south' });
    const PATH = rid('grass_path');
    const door = (upper: number) => rid('wooden_door', { upper_block_bit: upper, open_bit: 1, 'minecraft:cardinal_direction': 'west' });
    // flat grass (feet -60); a 1 x 1 hole at (5, 5) with a chest in cell -62; a wall at z 10 across the
    // world (3 high) with an open door at x 5 and a dirt path in front of it at (5, -61, 9)
    const blocks = (x: number, y: number, z: number): number => {
      if (x === 5 && z === 5 && y === -61) return AIR;
      if (x === 5 && z === 5 && y === -62) return CHEST;
      if (x === 5 && z === 9 && y === -61) return PATH;
      if (y < -61) return STONE;
      if (y === -61) return GRASS;
      if (z === 10 && y >= -60 && y <= -58) return x === 5 && y === -60 ? door(0) : x === 5 && y === -59 ? door(1) : STONE;
      return AIR;
    };
    const F = fixtureWorld(blocks);
    const client = new PlannerClient(F.world);
    client.start();
    await until(() => client.ready, 20_000);
    const spec: WorkerPlanOptions = { maxNodes: 100_000, maxMs: 10_000, allowBreak: false, allowPlace: false, allowOpen: false };
    const viaWorker = async (start: Vec3, goal: Vec3): Promise<PathResult> => {
      const ws = client.search('main', start, { type: 'block', p: goal }, spec, 0);
      let r: PathResult | undefined;
      while (!(r = ws.step())) {
        if (ws.failed) throw new Error('worker search failed');
        await sleep(1);
      }
      return r;
    };
    for (const [a, b] of [
      [{ x: 5, y: -62, z: 5 }, { x: 10, y: -60, z: 5 }],
      [{ x: 5, y: -61, z: 9 }, { x: 5, y: -60, z: 14 }],
      [{ x: 5, y: -60, z: 14 }, { x: 5, y: -62, z: 5 }],
    ] as const) {
      const t = findPath(new NavGrid(worldSource(F.world)), a, { type: 'block', p: b }, { maxNodes: 100_000, maxMs: 10_000 });
      const w = await viaWorker(a, b);
      expect(t.status, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`).toBe('found');
      expect(w.status).toBe('found');
      expect(Math.abs(w.cost - t.cost)).toBeLessThanOrEqual(1e-6);
    }
    client.dispose();
  }, 60_000);
});
