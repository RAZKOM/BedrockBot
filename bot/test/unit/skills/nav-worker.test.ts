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
import { breakBlocker } from '../../../src/skills/nav/actions.ts';
import { findPath, handBreakTicks, type PathResult } from '../../../src/skills/nav/astar.ts';
import { avoidWalkingInto, breakTicksWith, canWalkOn, canWalkThroughClass, getMiningDurationTicks } from '../../../src/skills/nav/baritone/helper.ts'; // Track BB; Track BC: breakTicksWith
import { goalTest, type NavGoal } from '../../../src/skills/nav/goals.ts'; // Track BD
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
const TOP_SLAB = rid('smooth_stone_slab', { 'minecraft:vertical_half': 'top' }); // Track BC: a 1.5-high passage
const BRICKS = rid('stone_bricks'); // Track BC: a built block (never dug)
// Track BB: the shared rule set's blocks (docs/pathfinding.md "Rules"), in a strip at z 14 / 15 (x -20 .. 14)
const RULE_STRIP: readonly (readonly [x: number, dy: number, rid: number])[] = [
  [-20, 1, rid('magma')],
  [-18, 1, rid('soul_sand')],
  [-16, 1, rid('sweet_berry_bush')],
  [-14, 1, rid('powder_snow')],
  [-12, 1, rid('honey_block')],
  [-10, 0, rid('ice')], // ice over water (the ground below it is water, see `hills`)
  [-10, -1, WATER],
  [-8, 1, STONE], // stone with gravel over it
  [-8, 2, rid('gravel')],
  [-6, 1, rid('white_carpet')],
  [-4, 1, rid('snow_layer', { height: 3 })],
  [-2, 1, rid('wither_rose')],
  [0, 0, rid('farmland')],
  [2, 1, rid('iron_door', { upper_block_bit: 0, open_bit: 0 })],
  [2, 2, rid('iron_door', { upper_block_bit: 1, open_bit: 0 })],
  [4, 1, rid('infested_stone')],
  [6, 1, SLAB],
  [8, 1, rid('oak_slab', { 'minecraft:vertical_half': 'top' })],
  [10, 1, FENCE],
  [12, 1, rid('glass_pane')],
  [14, 1, rid('sand')], // an unsupported gravity block: air under it? no, on the ground; the cell beside it (13) is dug in the compare
  [14, 2, rid('sand')],
];
const ruleStrip = new Map<string, number>(RULE_STRIP.map(([x, dy, r]) => [`${x},${dy}`, r]));
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
  // Track BC: a flat 1.5-high passage along x -4 .. 4 at z 20 (floor -60, top slabs at -58: sneak nodes at feet -59)
  if (z === 20 && x >= -4 && x <= 4) {
    if (y < -60) return STONE;
    if (y === -60) return GRASS;
    if (y === -58) return TOP_SLAB;
    return AIR;
  }
  // Track BC: a closed corridor along x -2 .. 6 at z 25 (stone walls at z 24 / 26 and x -3 / 7), flat floor -60 (feet -59),
  // a dirt step from x 3 on (feet -58) under a dirt lintel at (2, -57): the jump up needs a head-room break
  if (z >= 24 && z <= 26 && x >= -3 && x <= 7) {
    if (y < -60) return STONE;
    if (z !== 25 || x === -3 || x === 7) return y <= -55 ? STONE : AIR;
    if (y === -60) return GRASS;
    if (x === 3 && y === -59) return BRICKS; // the step's first block never dug (a dig-through into it would tie with the ascend)
    if (x > 3 && y === -59) return DIRT;
    if (x === 2 && y === -57) return DIRT;
    return AIR;
  }
  if (z === 14) {
    // Track BB: the rule strip (dy relative to the ground)
    const r = ruleStrip.get(`${x},${y - g}`);
    if (r !== undefined) return r;
  }
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

/**
 * Track BA: flat floor at y -61; a 3-high U (base across x = 12, z -10 .. 9, arms to x = 21) and a pen
 * (a 3-high ring round (-20, -20), cells -2 .. 2 inside, a gap at its west side).
 */
function uPen(x: number, y: number, z: number): number {
  if (y < -61) return STONE;
  if (y === -61) return GRASS;
  if (y > -58) return AIR;
  if (x === 12 && z >= -10 && z <= 9) return STONE;
  if (x >= 12 && x <= 21 && (z === -10 || z === 9)) return STONE;
  const px = x + 20;
  const pz = z + 20;
  if (Math.max(Math.abs(px), Math.abs(pz)) === 3 && !(px === -3 && pz === 0 && y <= -59)) return STONE;
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

/** Every planner-relevant fact of a cell: the block, its class, stand / standThrough, crossing, the sky column, and the shared rule set's answers (Track BB). */
function cellFacts(grid: NavGrid, x: number, y: number, z: number, neighbours = true): string {
  const b = grid.source.blockAt(x, y, z);
  const c = b && classify(b);
  const ctx = { breakTicks: handBreakTicks, dig: 12, rules: { allowGravityAbove: true } };
  return JSON.stringify([
    c && canWalkThroughClass(c),
    c && canWalkOn(c),
    c && avoidWalkingInto(c),
    neighbours ? breakBlocker(grid, x, y, z) : null,
    neighbours ? getMiningDurationTicks(grid, x, y, z, ctx, true) : null,
    neighbours ? getMiningDurationTicks(grid, x, y, z, { ...ctx, rules: {} }, false) : null,
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
    const compare = (label: string, list: Vec3[], neighbours = true) => {
      const main = new NavGrid(worldSource(F.world));
      const copy = new NavGrid(mirror.source);
      let bad = 0;
      for (const p of list) {
        const a = cellFacts(main, p.x, p.y, p.z, neighbours);
        const b = cellFacts(copy, p.x, p.y, p.z, neighbours);
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
    // Track BB: the rule strip, every cell with its neighbours in the column (the break rules read them)
    const strip: Vec3[] = [];
    for (const [x, dy] of RULE_STRIP) for (let k = -2; k <= 2; k++) strip.push({ x, y: groundY(x, 14) + dy + k, z: 14 }, { x: x + 1, y: groundY(x, 14) + dy + k, z: 14 });
    compare('rule strip', strip);
    const stripNames = new Set(strip.map((p) => F.world.blockAt(p)?.name));
    for (const n of ['magma', 'soul_sand', 'sweet_berry_bush', 'powder_snow', 'honey_block', 'ice', 'gravel', 'white_carpet', 'snow_layer', 'wither_rose', 'farmland', 'iron_door', 'infested_stone', 'oak_slab', 'oak_fence', 'glass_pane', 'sand']) {
      expect(stripNames.has(n), n).toBe(true);
    }
    // the rules answer as documented on a few strip cells (main grid; the mirror was compared above)
    const main = new NavGrid(worldSource(F.world));
    const gy = (x: number) => groundY(x, 14);
    expect(main.stand(-20, gy(-20) + 2, 14)).toBeNaN(); // on magma: never
    expect(main.stand(-18, gy(-18) + 1, 14)).toBe(gy(-18) + 1 + 0.875); // soul sand: a floor
    expect(main.stand(-16, gy(-16) + 1, 14)).toBeNaN(); // a berry bush
    expect(main.stand(-14, gy(-14) + 1, 14)).toBeNaN(); // powder snow
    expect(main.stand(-12, gy(-12) + 2, 14)).toBe(gy(-12) + 2); // honey: a floor (penalised x5)
    expect(main.crossing(2, gy(2) + 1, 14, 0)).toBe(2); // a closed iron door in the way: CROSS_BLOCKED (redstone only), never CROSS_TOGGLE
    expect([0, 2].map((a) => main.crossing(2, gy(2) + 1, 14, a as 0 | 2))).not.toContain(1); // along the panel: clear; never a toggle
    expect(main.stand(-10, gy(-10) + 1, 14)).toBe(gy(-10) + 1); // ice is walked on
    expect(breakBlocker(main, -10, gy(-10), 14)).toBe('ice'); // and never dug
    expect(breakBlocker(main, -8, gy(-8) + 1, 14)).toBe('gravity_above');
    expect(breakBlocker(main, 4, gy(4) + 1, 14)).toBe('infested');
    expect(main.stand(-6, gy(-6) + 1, 14)).toBe(gy(-6) + 1 + 0.0625); // carpet
    expect(main.stand(-4, gy(-4) + 1, 14)).toBe(gy(-4) + 1 + 0.375); // 4 snow layers
    expect(main.stand(-2, gy(-2) + 1, 14)).toBeNaN(); // wither rose
    expect(main.stand(0, gy(0), 14)).toBe(gy(0) + 0.9375); // farmland
    expect(main.stand(6, gy(6) + 1, 14)).toBe(gy(6) + 1.5); // a bottom slab
    expect(main.stand(8, gy(8) + 2, 14)).toBe(gy(8) + 2); // a top slab: the node above
    expect(main.stand(10, gy(10) + 2, 14)).toBeNaN(); // a fence is 1.5 high
    expect(main.stand(12, gy(12) + 2, 14)).toBe(gy(12) + 2); // a pane's post is stood on

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
    // (without the break rules: they read the x / z neighbours, which may lie in a cached column the corridor did not send)
    compare('cached', randomCells(200, 2, { x0: 0, x1: C1 * 16 + 15, z0: -16, z1: 31 }), false);
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

  it('Track BC: the moves that dig plan identically in the worker: 20 dig-heavy start / goal pairs (goals inside the rock), same cost, length and break sets', async () => {
    const F = fixtureWorld(hills);
    const client = new PlannerClient(F.world);
    client.start();
    await until(() => client.ready, 20_000);
    const main = () => new NavGrid(worldSource(F.world));
    const inv = { slots: [{ name: 'iron_pickaxe', count: 1 }, { name: 'cobblestone', count: 64 }], selected: 0 };
    const stands = (p: Vec3) => {
      const f = main().stand(p.x, p.y, p.z);
      return f !== undefined && !Number.isNaN(f);
    };
    const pick = (i: number, dy: number): Vec3 => {
      for (let k = 0; ; k++) {
        const x = C0 * 16 + 8 + Math.floor(hash(i, k + 11) * 80);
        const z = C0 * 16 + 8 + Math.floor(hash(k + 11, i) * 80);
        const p = { x, y: groundY(x, z) + dy, z };
        if (dy > 0 ? stands(p) : main().cls(x, p.y, z)?.name === 'stone') return p;
      }
    };
    const lines: string[] = [];
    let same = 0;
    let dug = 0;
    const kinds = new Set<string>();
    for (let i = 0; i < 22; i++) {
      // pair 20: the body under the passage's ceiling (a sneak start node), the goal on the hills beyond;
      // pair 21: the closed corridor with the step under a lintel (an ascend with a head-room break)
      const a = i < 20 ? pick(2 * i, 1) : i === 20 ? { x: 0, y: -59, z: 20 } : { x: 0, y: -59, z: 25 };
      const b = i < 20 ? pick(2 * i + 1, -3) : i === 20 ? { x: 0, y: groundY(0, 30) + 1, z: 30 } : { x: 5, y: -58, z: 25 }; // inside the stone, 3 under the grass
      const allowGravityAbove = i % 2 === 0;
      const allowPlace = i % 3 !== 0;
      const spec: WorkerPlanOptions = { maxNodes: 60_000, maxMs: 20_000, allowBreak: true, allowPlace, allowOpen: true, allowGravityAbove, throwaway: allowPlace ? 64 : 0, inventory: inv };
      const t = findPath(main(), a, { type: 'block', p: b }, { maxNodes: 60_000, maxMs: 20_000, allowBreak: true, allowPlace, allowOpen: true, allowGravityAbove, throwaway: allowPlace ? 64 : 0, breakTicks: (c) => breakTicksWith(c, inv) });
      const s = client.search('main', a, { type: 'block', p: b }, spec, 0);
      let w: PathResult | undefined;
      while (!(w = s.step())) {
        if (s.failed) throw new Error('worker search failed');
        await sleep(1);
      }
      const breaks = (r: PathResult) => JSON.stringify(r.path.map((n) => [n.move, n.act?.dig ?? null, n.act?.place?.p ?? null]));
      const nDigs = t.path.reduce((n, p) => n + (p.act?.dig?.length ?? 0), 0);
      dug += nDigs;
      lines.push(`${a.x},${a.y},${a.z} -> ${b.x},${b.y},${b.z}: thread ${t.status} ${t.cost.toFixed(2)} (${t.expanded}e, ${t.path.length}n, ${nDigs} digs, ${t.ms.toFixed(0)} ms) worker ${w.status} ${w.cost.toFixed(2)} (${w.expanded}e, ${w.path.length}n)`);
      expect(w.status, lines.at(-1)).toBe(t.status);
      expect(w.cost, lines.at(-1)).toBeCloseTo(t.cost, 9);
      expect(w.expanded, lines.at(-1)).toBe(t.expanded);
      expect(w.path.length, lines.at(-1)).toBe(t.path.length);
      expect(breaks(w), lines.at(-1)).toBe(breaks(t));
      if (w.status === 'found') same++;
      for (const n of t.path) kinds.add(n.move + (n.act?.dig ? '+dig' : ''));
      if (i === 20) {
        expect(t.status, lines.at(-1)).toBe('found');
        expect(t.path[1]!.move).toBe('sneak');
        expect(w.path[1]!.move).toBe('sneak');
      }
      if (i === 21) {
        expect(t.status, lines.at(-1)).toBe('found');
        const up = t.path.find((n) => n.move === 'jump' && n.act?.dig);
        expect(up?.act?.dig).toEqual([{ x: 2, y: -57, z: 25 }]);
      }
    }
    console.log(`[nav-worker] Track BC dig moves: ${same}/22 found, ${dug} dig cells in all, kinds ${[...kinds].sort().join(' ')}\n  ${lines.join('\n  ')}`);
    expect(same).toBeGreaterThanOrEqual(17);
    expect(dug).toBeGreaterThan(40);
    for (const k of ['downward+dig', 'jump+dig', 'drop+dig', 'sneak']) expect([...kinds], k).toContain(k); // (dig-through: nav-baritone-helper / nav-digmoves)
    client.dispose();
  }, 120_000);

  it('Track BD: the mine process\' composite goals plan identically in the worker: 20 mine-shaped queries (twoBlocks / threeBlocks members inside the stone and exposed, mineSeenOnly off and on), same status, cost, length, break set and member', async () => {
    const F = fixtureWorld(hills);
    const client = new PlannerClient(F.world);
    client.start();
    await until(() => client.ready, 20_000);
    const main = () => new NavGrid(worldSource(F.world));
    const inv = { slots: [{ name: 'iron_pickaxe', count: 1 }, { name: 'cobblestone', count: 64 }], selected: 0 };
    const stands = (p: Vec3) => {
      const f = main().stand(p.x, p.y, p.z);
      return f !== undefined && !Number.isNaN(f);
    };
    const pick = (i: number, dy: number): Vec3 => {
      for (let k = 0; ; k++) {
        const x = C0 * 16 + 8 + Math.floor(hash(i, k + 23) * 80);
        const z = C0 * 16 + 8 + Math.floor(hash(k + 23, i) * 80);
        const p = { x, y: groundY(x, z) + dy, z };
        if (dy > 0 ? stands(p) : main().cls(x, p.y, z)?.name === (dy === 0 ? 'grass_block' : 'stone')) return p;
      }
    };
    const lines: string[] = [];
    let found = 0;
    let dug = 0;
    const members = new Set<number>();
    for (let i = 0; i < 20; i++) {
      // mineSeenOnly off (even i): 3 to 5 ores buried 3 to 6 blocks under the grass; on (odd i): the exposed grass-level
      // blocks of 3 columns (an open face above), as the memory's seen set would give; both as Baritone's column goals
      const seenOnly = i % 2 === 1;
      const a = pick(3 * i, 1);
      const n = 3 + (i % 3);
      const goals: NavGoal[] = [];
      for (let m = 0; m < n; m++) {
        const b = seenOnly ? pick(3 * i + 1 + 7 * m, 0) : pick(3 * i + 1 + 7 * m, -3 - (m % 4));
        goals.push(m % 2 === 0 ? { type: 'threeBlocks', p: b } : { type: 'twoBlocks', p: b });
      }
      const goal: NavGoal = { type: 'any', goals };
      const allowPlace = i % 3 !== 0;
      const spec: WorkerPlanOptions = { maxNodes: 60_000, maxMs: 20_000, allowBreak: true, allowPlace, allowOpen: true, throwaway: allowPlace ? 64 : 0, inventory: inv };
      const t = findPath(main(), a, goal, { maxNodes: 60_000, maxMs: 20_000, allowBreak: true, allowPlace, allowOpen: true, throwaway: allowPlace ? 64 : 0, breakTicks: (c) => breakTicksWith(c, inv) });
      const s = client.search('main', a, goal, spec, 0);
      let w: PathResult | undefined;
      while (!(w = s.step())) {
        if (s.failed) throw new Error('worker search failed');
        await sleep(1);
      }
      const breaks = (r: PathResult) => JSON.stringify(r.path.map((p) => [p.move, p.act?.dig ?? null, p.act?.place?.p ?? null]));
      const end = (r: PathResult) => {
        const e = r.path.at(-1);
        return e ? goalTest(goal, main()).member!(e.x, e.y, e.z, e.feet) : -2;
      };
      const nDigs = t.path.reduce((k, p) => k + (p.act?.dig?.length ?? 0), 0);
      dug += nDigs;
      lines.push(`${seenOnly ? 'seen' : 'buried'} ${a.x},${a.y},${a.z} -> ${n} goals: thread ${t.status} ${t.cost.toFixed(2)} (${t.expanded}e, ${t.path.length}n, ${nDigs} digs, member ${end(t)}) worker ${w.status} ${w.cost.toFixed(2)} (${w.expanded}e, ${w.path.length}n, member ${end(w)})`);
      expect(w.status, lines.at(-1)).toBe(t.status);
      expect(w.cost, lines.at(-1)).toBeCloseTo(t.cost, 9);
      expect(w.expanded, lines.at(-1)).toBe(t.expanded);
      expect(w.path.length, lines.at(-1)).toBe(t.path.length);
      expect(breaks(w), lines.at(-1)).toBe(breaks(t));
      expect(end(w), lines.at(-1)).toBe(end(t));
      if (t.status === 'found') {
        found++;
        members.add(end(t));
        expect(end(t), lines.at(-1)).toBeGreaterThanOrEqual(0);
      }
    }
    console.log(`[nav-worker] Track BD composite goals: ${found}/20 found, ${dug} dig cells in all, members reached ${[...members].sort().join(' ')}\n  ${lines.join('\n  ')}`);
    expect(found).toBeGreaterThanOrEqual(16);
    expect(dug).toBeGreaterThan(20);
    client.dispose();
  }, 120_000);

  it('Track BD review: no pillar place inside protectedArea, in the thread and the worker alike (the mine process plans with allowPlace)', async () => {
    const F = fixtureWorld(hills);
    const client = new PlannerClient(F.world);
    client.start();
    await until(() => client.ready, 20_000);
    const main = () => new NavGrid(worldSource(F.world));
    const inv = { slots: [{ name: 'iron_pickaxe', count: 1 }, { name: 'cobblestone', count: 64 }], selected: 0 };
    const x = C0 * 16 + 40;
    const z = C0 * 16 + 40;
    const a = { x, y: groundY(x, z) + 1, z };
    const goal: NavGoal = { type: 'block', p: { x, y: a.y + 4, z } }; // straight up into the air: only a pillar reaches it
    const places = (r: PathResult) => r.path.filter((n) => n.act?.place).length;
    const lines: string[] = [];
    for (const area of [undefined, { x: a.x, y: a.y, z: a.z, r: 48 }]) {
      const o = { maxNodes: 20_000, maxMs: 10_000, allowBreak: true, allowPlace: true, allowOpen: true, throwaway: 64, ...(area ? { protectedArea: area } : {}) };
      const t = findPath(main(), a, goal, { ...o, breakTicks: (c) => breakTicksWith(c, inv) });
      const s = client.search('main', a, goal, { ...o, inventory: inv }, 0);
      let w: PathResult | undefined;
      while (!(w = s.step())) {
        if (s.failed) throw new Error('worker search failed');
        await sleep(1);
      }
      lines.push(`${area ? 'protected' : 'open'}: thread ${t.status} ${places(t)} places, worker ${w.status} ${places(w)} places`);
      expect(w.status, lines.at(-1)).toBe(t.status);
      expect(places(w), lines.at(-1)).toBe(places(t));
      if (area) {
        expect(places(t), lines.at(-1)).toBe(0);
        expect(t.status, lines.at(-1)).not.toBe('found');
      } else {
        expect(t.status, lines.at(-1)).toBe('found');
        expect(places(t), lines.at(-1)).toBe(4);
      }
    }
    client.dispose();
  }, 120_000);

  it('Track BA: partial answers (the coefficient best, and no_progress with the start alone) cross the thread unchanged', async () => {
    const F = fixtureWorld(uPen);
    const client = new PlannerClient(F.world);
    client.start();
    await until(() => client.ready, 20_000);
    const grid = new NavGrid(worldSource(F.world));
    const lines: string[] = [];
    for (const [start, goal, maxNodes] of [
      [{ x: 0, y: -60, z: 0 }, { x: 30, y: -60, z: 0 }, 100], // ends at the U's base (11, 0)
      [{ x: 0, y: -60, z: 0 }, { x: 17, y: -60, z: 0 }, 300],
      [{ x: -20, y: -60, z: -20 }, { x: 20, y: -60, z: -20 }, 2], // in the pen: no_progress
    ] as const) {
      const spec: WorkerPlanOptions = { maxNodes, maxMs: 20_000, allowBreak: false, allowPlace: false, allowOpen: false };
      const t = findPath(grid, start, { type: 'block', p: goal }, { maxNodes, maxMs: 20_000 });
      const s = client.search('main', start, { type: 'block', p: goal }, spec, 0);
      let w: PathResult | undefined;
      while (!(w = s.step())) {
        if (s.failed) throw new Error('worker search failed');
        await sleep(1);
      }
      const e = (r: PathResult) => `${r.status}${r.reason ? `/${r.reason}` : ''} ${r.path.length}n end ${r.path.at(-1)!.x},${r.path.at(-1)!.z} ${r.expanded}e`;
      lines.push(`${maxNodes} nodes: thread ${e(t)} worker ${e(w)}`);
      expect(t.status, lines.at(-1)).toBe('partial');
      expect(w.status, lines.at(-1)).toBe(t.status);
      expect(w.reason, lines.at(-1)).toBe(t.reason);
      expect(w.expanded, lines.at(-1)).toBe(t.expanded);
      expect(w.path, lines.at(-1)).toEqual(t.path);
    }
    console.log(`[nav-worker] Track BA partial answers: ${lines.join('; ')}`);
    expect(lines[0]).toContain('end 11,0');
    expect(lines[2]).toContain('partial/no_progress 1n');
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

  it('Track BH: long drops (damage within the budget, hay, a clutch) plan identically in the worker', async () => {
    const HAY = rid('hay_block', { pillar_axis: 'y' });
    // flat grass (feet -60); a stone plateau x 0..10, z 0..10 with its top at -49 (feet -48, 12 over the ground); hay under its east edge at z 0..3
    const blocks = (x: number, y: number, z: number): number => {
      if (x >= 0 && x <= 10 && z >= 0 && z <= 10 && y >= -60 && y <= -49) return STONE;
      if (x === 11 && z <= 3 && z >= 0 && y === -61) return HAY;
      if (y < -61) return STONE;
      if (y === -61) return GRASS;
      return AIR;
    };
    const F = fixtureWorld(blocks);
    const client = new PlannerClient(F.world);
    client.start();
    await until(() => client.ready, 20_000);
    const base = { hpBudget: 12, factor: 1, hpCost: 40, maxScan: 48, clutch: false, clutchMax: 40, clutchCost: 40 };
    const cases: { falls?: typeof base; goal: Vec3; want: PathResult['status'] }[] = [
      { goal: { x: 20, y: -60, z: 6 }, want: 'none' },
      { falls: base, goal: { x: 20, y: -60, z: 6 }, want: 'found' },
      { falls: { ...base, hpBudget: 7 }, goal: { x: 20, y: -60, z: 6 }, want: 'found' }, // the hay (0 HP) only
      { falls: { ...base, hpBudget: 0, clutch: true }, goal: { x: 20, y: -60, z: 6 }, want: 'found' },
      { falls: { ...base, hpBudget: 0, maxScan: 10 }, goal: { x: 20, y: -60, z: 6 }, want: 'none' },
    ];
    const a = { x: 9, y: -48, z: 6 };
    for (const c of cases) {
      const spec: WorkerPlanOptions = { maxNodes: 100_000, maxMs: 10_000, allowBreak: false, allowPlace: false, allowOpen: false, ...(c.falls ? { falls: c.falls } : {}) };
      const t = findPath(new NavGrid(worldSource(F.world)), a, { type: 'block', p: c.goal }, { maxNodes: 100_000, maxMs: 10_000, ...(c.falls ? { falls: c.falls } : {}) });
      const ws = client.search('main', a, { type: 'block', p: c.goal }, spec, 0);
      let w: PathResult | undefined;
      while (!(w = ws.step())) {
        if (ws.failed) throw new Error('worker search failed');
        await sleep(1);
      }
      const what = `${JSON.stringify(c.falls)}: thread ${t.status} ${t.cost.toFixed(2)} worker ${w.status} ${w.cost.toFixed(2)}`;
      expect(t.status, what).toBe(c.want);
      expect(w.status, what).toBe(t.status);
      expect(Math.abs(w.cost - t.cost), what).toBeLessThanOrEqual(1e-6);
      expect(w.path.map((n) => `${n.x},${n.y},${n.z}`), what).toEqual(t.path.map((n) => `${n.x},${n.y},${n.z}`));
    }
    client.dispose();
  }, 60_000);
});
