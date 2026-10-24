// Persistent world cache (PLAN.md task 7.12, Track T): summaries of loaded columns, block updates,
// unload into regions, stand-ins for the planner, finders, region files on disk, the reload check,
// corrections when a cached column loads, LRU bounds, corrupt files, two processes on one region.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import { findPath } from '../../../src/skills/nav/astar.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { blockQueryOf, worldSource } from '../../../src/skills/terrain/query.ts';
import {
  ChunkSummary,
  CLS_AIR,
  CLS_AVOID,
  CLS_SOLID,
  CLS_WATER,
  decodeSummary,
  encodeRaw,
  encodeSummary,
  findCachedTrees,
  parseRegion,
  serializeRegion,
  serverIdFor,
  WorldCache,
  Y_NONE,
} from '../../../src/world/cache/index.ts';
import { World } from '../../../src/world/index.ts';
import type { BlockInfo, Vec3 } from '../../../src/world/types.ts';
import { encodeSubChunk, fillSection, readyRegistry, recordedLogin, ReplaySource } from '../world/helpers.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bb-cache-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const reg = readyRegistry();
const rid = (name: string, states?: Record<string, unknown>): number => reg.runtimeIdOf(reg.stateIdOf(name, states)!);
const AIR = rid('air');
const STONE = rid('stone');
const LOG = rid('oak_log', { pillar_axis: 'y' });
const LEAVES = rid('oak_leaves');
const WATER = rid('water');
const LAVA = rid('lava');
const CHEST = rid('chest');
const COAL = rid('coal_ore');
const IRON = rid('iron_ore');
const SLAB = rid('smooth_stone_slab');

interface Variant {
  /** Replace the log at (8, -48, 8) of column (0, 0) with air. */
  noBottomLog?: boolean;
  /** Put a slab at (4, -48, 4) of column (0, 0). */
  slab?: boolean;
}

/** Section 0 (y -64..-49) of column (cx, cz): stone, with ores, a water pool and lava in column (0, 0). */
function section0(cx: number, cz: number): number[] {
  return fillSection((x, y, z) => {
    if (cx === 0 && cz === 0) {
      if (x === 3 && z === 3 && y === 14) return COAL; // buried
      if (x === 5 && z === 5 && y === 15) return IRON; // exposed (air above)
      if (y === 15 && x <= 2 && z >= 12 && z <= 14) return WATER;
      if (y === 15 && x >= 13 && x <= 14 && z >= 1 && z <= 2) return LAVA;
    }
    return STONE;
  });
}

/** Section 1 (y -48..-33) of column (0, 0): a tree at (8, 8) (logs -48..-44, leaves -45..-42), a chest. */
function section1(v: Variant): number[] {
  return fillSection((x, y, z) => {
    if (x === 8 && z === 8 && y <= 4) return v.noBottomLog && y === 0 ? AIR : LOG;
    if (y >= 3 && y <= 5 && Math.abs(x - 8) <= 2 && Math.abs(z - 8) <= 2) return LEAVES;
    if (y === 6 && Math.abs(x - 8) <= 1 && Math.abs(z - 8) <= 1) return LEAVES;
    if (x === 12 && z === 8 && y === 0) return CHEST;
    if (v.slab && x === 4 && z === 4 && y === 0) return SLAB;
    return AIR;
  });
}

function newWorld(): { src: ReplaySource; world: World } {
  const src = new ReplaySource();
  const world = new World(src, { logger: silentLogger, defer: (fn) => fn() });
  const { startGame, itemRegistry } = recordedLogin();
  src.emit('start_game', startGame);
  src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
  return { src, world };
}

/** Sends column (cx, cz): two sections, the second one only for (0, 0). */
function sendColumn(src: ReplaySource, cx: number, cz: number, v: Variant = {}): void {
  src.emit('level_chunk', { x: cx, z: cz, dimension: 0, sub_chunk_count: 0, highest_subchunk_count: 2, cache_enabled: false, blobs: [], payload: Buffer.alloc(0) });
  const tree = cx === 0 && cz === 0;
  src.emit('subchunk', {
    cache_enabled: false,
    dimension: 0,
    origin: { x: cx, y: -4, z: cz },
    entries: [
      { dx: 0, dy: 0, dz: 0, result: 'success', payload: encodeSubChunk([section0(cx, cz)], { y: -4 }) },
      tree ? { dx: 0, dy: 1, dz: 0, result: 'success', payload: encodeSubChunk([section1(v)], { y: -3 }) } : { dx: 0, dy: 1, dz: 0, result: 'success_all_air' },
    ],
  });
}

function center(src: ReplaySource, x: number, z: number, radius = 32): void {
  src.emit('network_chunk_publisher_update', { coordinates: { x, y: 0, z }, radius, saved_chunks: [] });
}

/** 3 x 3 columns around (0, 0), cache attached before they arrive. */
function setup(dir = tmp(), opts: { maxChunks?: number } = {}) {
  const { src, world } = newWorld();
  center(src, 8, 8);
  const cache = new WorldCache({ dir, flushIntervalMs: 0, logger: silentLogger, ...opts });
  cache.attach(world);
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) sendColumn(src, cx, cz);
  return { src, world, cache, dir };
}

const name = (b: BlockInfo | undefined): string | undefined => b?.name;

describe('world cache: summaries', () => {
  it('summarizes a loaded column: classes, column tops, roofs, marks', () => {
    const { world, cache } = setup();
    expect(world.chunks.loadedCount).toBe(9);
    const s = cache.liveSummary(0, 0)!;
    expect(s.y0).toBe(-64);
    expect(s.rows).toBe(32);
    expect(s.cls(0, -50, 0)).toBe(CLS_SOLID);
    expect(s.cls(0, -48, 0)).toBe(CLS_AIR);
    expect(s.cls(1, -49, 13)).toBe(CLS_WATER);
    expect(s.cls(13, -49, 1)).toBe(CLS_AVOID);
    expect(s.cls(8, -46, 8)).toBe(CLS_SOLID);
    expect(s.cls(0, 100, 0)).toBe(CLS_AIR);
    const ci = (x: number, z: number) => z * 16 + x;
    expect(s.top[ci(8, 8)]).toBe(-42); // leaves above the trunk
    expect(s.roof[ci(8, 8)]).toBe(-44); // the highest log
    expect(s.top[ci(6, 8)]).toBe(-43);
    expect(s.roof[ci(6, 8)]).toBe(-49); // leaves are no roof
    expect(s.roof[ci(1, 13)]).toBe(-49); // water is
    expect(s.top[ci(1, 13)]).toBe(-50);
    expect(s.standIn(8, -43, 8)).toBe(4); // solid above the roof: leaves
    expect(s.standIn(8, -45, 8)).toBe(CLS_SOLID);
    const marks = s.markList().sort((a, b) => a.y - b.y || a.x - b.x);
    expect(marks.filter((m) => m.name === 'oak_log')).toHaveLength(5);
    expect(marks.find((m) => m.name === 'coal_ore')).toMatchObject({ x: 3, y: -50, z: 3, exposed: false });
    expect(marks.find((m) => m.name === 'iron_ore')).toMatchObject({ x: 5, y: -49, z: 5, exposed: true });
    expect(marks.find((m) => m.name === 'chest')).toMatchObject({ x: 12, y: -48, z: 8, exposed: true });
    // a plain column: stone to -49, nothing else
    const p = cache.liveSummary(1, 1)!;
    expect(p.top[0]).toBe(-49);
    expect(p.marks.size).toBe(0);
  });

  it('keeps the live summary current on block updates (class, top, roof, marks, exposure)', () => {
    const { src, cache } = setup();
    const s = cache.liveSummary(0, 0)!;
    const rev0 = s.rev;
    // dig the stone above the coal: now exposed; place a log on top of the leaves (new top and roof)
    src.emit('update_block', { position: { x: 3, y: -49, z: 3 }, block_runtime_id: AIR, flags: {}, layer: 0 });
    src.emit('update_block', { position: { x: 7, y: -41, z: 8 }, block_runtime_id: LOG, flags: {}, layer: 0 });
    src.emit('update_block', { position: { x: 12, y: -48, z: 8 }, block_runtime_id: AIR, flags: {}, layer: 0 });
    expect(s.cls(3, -49, 3)).toBe(CLS_AIR);
    expect(s.markList().find((m) => m.name === 'coal_ore')?.exposed).toBe(true);
    expect(s.top[8 * 16 + 7]).toBe(-41);
    expect(s.roof[8 * 16 + 7]).toBe(-41);
    expect(s.markList().some((m) => m.name === 'chest')).toBe(false);
    expect(s.rev).toBeGreaterThan(rev0);
    // a block above the stored rows grows the range
    src.emit('update_block', { position: { x: 0, y: 40, z: 0 }, block_runtime_id: STONE, flags: {}, layer: 0 });
    expect(s.cls(0, 40, 0)).toBe(CLS_SOLID);
    expect(s.top[0]).toBe(40);
  });

  it('encodes and decodes a summary losslessly; region files round-trip', () => {
    const { cache } = setup();
    const s = cache.liveSummary(0, 0)!;
    const data = encodeSummary(s);
    const back = decodeSummary(data);
    expect(back.checksum()).toBe(s.checksum());
    expect(back.cx).toBe(0);
    expect(back.updatedAt).toBe(s.updatedAt);
    expect(encodeRaw(s).length).toBeGreaterThan(data.length);
    const region = new Map([
      [0, data],
      [33, encodeSummary(cache.liveSummary(1, 1)!)],
    ]);
    const parsed = parseRegion(serializeRegion(region));
    expect([...parsed.keys()]).toEqual([0, 33]);
    expect(Buffer.from(parsed.get(0)!).equals(Buffer.from(data))).toBe(true);
    expect(() => parseRegion(Buffer.from('nope'))).toThrow();
    expect(() => decodeSummary(Buffer.from([1, 2, 3]))).toThrow();
  });
});

describe('world cache: unloaded columns', () => {
  it('serves stand-ins for unloaded columns to the planner, never to the physics', () => {
    const { src, world, cache } = setup();
    const sums = new Map([...[0, 1].map((cx) => [cx, cache.liveSummary(cx, 0)!.checksum()] as const)]);
    center(src, 1600, 0); // everything unloads
    expect(world.chunks.loadedCount).toBe(0);
    expect(cache.liveSummary(0, 0)).toBeUndefined();
    expect(cache.cachedSummary(0, 0)?.checksum()).toBe(sums.get(0));
    expect(name(cache.blockAt(8, -45, 8))).toBe('stone');
    expect(name(cache.blockAt(8, -43, 8))).toBe('oak_leaves');
    expect(name(cache.blockAt(1, -49, 13))).toBe('water');
    expect(name(cache.blockAt(13, -49, 1))).toBe('lava');
    expect(name(cache.blockAt(0, -30, 0))).toBe('air');
    expect(cache.blockAt(500, -50, 500)).toBeUndefined();
    expect(cache.columnTop(8, 8)).toBe(-44);
    expect(cache.columnTop(20, 20)).toBe(-49);

    const src2 = worldSource(world);
    expect(world.blockAt({ x: 8, y: -45, z: 8 })).toBeUndefined();
    expect(name(src2.blockAt(8, -45, 8))).toBe('stone');
    expect(src2.cached?.(8, 8)).toBe(true);
    expect(src2.cached?.(800, 8)).toBe(false);
    expect(src2.columnTop?.(8, 8)).toBe(-44);
    const physics = blockQueryOf(src2);
    expect(physics.solidAt(8, -45, 8)).toBeUndefined();
    // the planner's sky scan: the tree column has its roof at the log top
    const grid = new NavGrid(src2);
    expect(grid.skyTop(8, 8)).toBe(-44);
    expect(grid.stand(0, -48, 0)).toBe(-48);
  });

  it('World.find returns cached marks flagged, by class; cached: false skips them; trees come back', () => {
    const { src, world, cache } = setup();
    const origin = { x: 8, y: -46, z: 8 };
    const isLog = (b: BlockInfo) => b.name.endsWith('_log');
    const live = world.find(isLog, { origin, radius: 16, max: 10, class: 'log' });
    expect(live).toHaveLength(5);
    expect(live.every((p) => !p.cached)).toBe(true);
    center(src, 1600, 0);
    const cached = world.find(isLog, { origin, radius: 16, max: 10, class: 'log' });
    expect(cached.map((p) => p.y).sort((a, b) => a - b)).toEqual([-48, -47, -46, -45, -44]);
    expect(cached.every((p) => p.cached === true)).toBe(true);
    expect(world.find(isLog, { origin, radius: 16, max: 10, class: 'log', cached: false })).toEqual([]);
    expect(world.find((b) => b.name === 'chest', { origin, radius: 16, max: 10, class: 'chest' })).toEqual([{ x: 12, y: -48, z: 8, cached: true }]);
    expect(world.find((b) => b.name.endsWith('_ore'), { origin, radius: 32, max: 10 })).toHaveLength(2);
    const trees = findCachedTrees(world, cache, origin, 32);
    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({ kind: 'oak', base: { x: 8, y: -48, z: 8 }, top: -44, cached: true, partial: true });
    expect(trees[0]!.leaves).toBeGreaterThan(10); // stand-in leaves above the roof
  });

  it('plans through cached terrain beyond the loaded edge (found), partial without the cache', () => {
    const { src, world } = newWorld();
    center(src, 8, 8, 400);
    const cache = new WorldCache({ dir: tmp(), flushIntervalMs: 0, logger: silentLogger });
    cache.attach(world);
    for (let cx = 0; cx <= 12; cx++) sendColumn(src, cx, 1);
    for (let cx = 0; cx <= 12; cx++) sendColumn(src, cx, 2);
    center(src, 8, 24); // unload distance 4: columns cx >= 5 unload
    expect(world.isLoaded(4, 1)).toBe(true);
    expect(world.isLoaded(6, 1)).toBe(false);
    const goal = { type: 'block' as const, p: { x: 200, y: -48, z: 24 } };
    const res = findPath(new NavGrid(worldSource(world)), { x: 2, y: -48, z: 24 }, goal);
    expect(res.status).toBe('found');
    expect(res.path.length).toBeGreaterThan(190);
    cache.close();
    world.cache = undefined;
    const res2 = findPath(new NavGrid(worldSource(world)), { x: 2, y: -48, z: 24 }, goal);
    expect(res2.status).toBe('partial');
    expect(res2.unknown).toBe(true);
  });

  it('announces cells that differ when a column the planner read from the cache loads', () => {
    const dir = tmp();
    const a = setup(dir);
    a.cache.close();
    const { src, world } = newWorld();
    center(src, 1600, 0);
    const cache = new WorldCache({ dir, flushIntervalMs: 0, logger: silentLogger });
    cache.attach(world);
    const ws = worldSource(world);
    expect(name(ws.blockAt(8, -48, 8))).toBe('stone'); // the planner reads stand-ins of (0, 0)
    expect(name(ws.blockAt(4, -48, 4))).toBe('air');
    expect(name(ws.blockAt(0, -48, 0))).toBe('air'); // read, unchanged: no event
    expect(name(ws.blockAt(1, -49, 13))).toBe('water'); // read, same signature: no event
    expect(ws.columnTop?.(12, 8)).toBe(-48); // the chest column's roof (read, unchanged)
    const events: { p: Vec3; before: string | undefined; after: string }[] = [];
    world.onBlockUpdate((p, before, after) => events.push({ p, before: before?.name, after: after.name }));
    center(src, 8, 8);
    sendColumn(src, 1, 1); // not read by the planner: no events
    expect(events).toHaveLength(0);
    sendColumn(src, 0, 0, { noBottomLog: true, slab: true });
    const got = events.map((e) => `${e.p.x},${e.p.y},${e.p.z}:${e.before}->${e.after}`).sort();
    // the chest cell was never read through blockAt: only the two read cells that changed
    expect(got).toEqual(['4,-48,4:air->smooth_stone_slab', '8,-48,8:stone->air'].sort());
    expect(cache.stats.corrections).toBe(1);
  });
});

describe('world cache: disk', () => {
  it('writes region files on close and a fresh cache reads identical summaries', () => {
    const { src, cache, dir } = setup();
    const sums = new Map<string, string>();
    for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) sums.set(`${cx},${cz}`, cache.liveSummary(cx, cz)!.checksum());
    center(src, 1600, 0);
    cache.close();
    expect(readdirSync(dir).sort()).toEqual(['r.-1.-1.bin', 'r.-1.0.bin', 'r.0.-1.bin', 'r.0.0.bin']);
    const fresh = new WorldCache({ dir, readOnly: true, logger: silentLogger });
    for (const [k, sum] of sums) {
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      expect(fresh.cachedSummary(cx, cz)?.checksum()).toBe(sum);
    }
    expect(fresh.cachedSummary(5, 5)).toBeUndefined();
    expect(fresh.storedChunks()).toHaveLength(9);
  });

  it('writes live columns too (periodic flush), and bounds the decoded LRU', async () => {
    const { world, cache, dir, src } = setup(tmp(), { maxChunks: 2 });
    await cache.flush();
    expect(existsSync(join(dir, 'r.0.0.bin'))).toBe(true);
    expect(world.chunks.loadedCount).toBe(9);
    center(src, 1600, 0);
    for (let i = 0; i < 2; i++) for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) expect(cache.cachedSummary(cx, cz)).toBeDefined();
    expect(cache.info().decoded).toBeLessThanOrEqual(2);
    expect(cache.stats.evictedChunks).toBeGreaterThan(0);
    expect(name(cache.blockAt(8, -45, 8))).toBe('stone');
  });

  it('starts a corrupt region empty and moves the file aside', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'r.5.5.bin'), Buffer.from('garbage garbage'));
    const cache = new WorldCache({ dir, flushIntervalMs: 0, logger: silentLogger });
    expect(cache.has(160, 160)).toBe(false);
    expect(cache.stats.errors).toBe(1);
    expect(readdirSync(dir).some((f) => f.startsWith('r.5.5.bin.corrupt-'))).toBe(true);
  });

  it('two caches writing one region keep each other\'s chunks', () => {
    const dir = tmp();
    const a = newWorld();
    const b = newWorld();
    for (const w of [a, b]) center(w.src, 8, 8);
    const ca = new WorldCache({ dir, flushIntervalMs: 0, logger: silentLogger });
    const cb = new WorldCache({ dir, flushIntervalMs: 0, logger: silentLogger });
    ca.attach(a.world);
    cb.attach(b.world);
    sendColumn(a.src, 0, 0);
    sendColumn(b.src, 1, 0);
    expect(cb.has(0, 0)).toBe(false); // b reads the (empty) region now
    ca.close();
    cb.close();
    const fresh = new WorldCache({ dir, readOnly: true });
    expect(fresh.cachedSummary(0, 0)).toBeDefined();
    expect(fresh.cachedSummary(1, 0)).toBeDefined();
  });
});

describe('world cache: misc', () => {
  it('derives a stable, directory-safe server id', () => {
    expect(serverIdFor('127.0.0.1:19184')).toMatch(/^127\.0\.0\.1-19184-[0-9a-f]{8}$/);
    expect(serverIdFor('127.0.0.1:19184')).toBe(serverIdFor('127.0.0.1:19184'));
    expect(serverIdFor('127.0.0.1:19185')).not.toBe(serverIdFor('127.0.0.1:19184'));
    expect(serverIdFor('realm:"My Realm"')).toMatch(/^realm-my-realm-[0-9a-f]{8}$/);
    expect(serverIdFor('../../etc')).not.toContain('/');
  });

  it('measures the summary size of a natural-looking column', () => {
    const s = new ChunkSummary(0, 0, -64, 176);
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = -64; y < 60 + ((x * 7 + z * 3) % 9); y++) s.setCls(x, y, z, y % 13 === 0 && x > 4 ? CLS_AIR : CLS_SOLID);
    expect(s.top[0]).toBe(Y_NONE);
    const raw = encodeRaw(s).length;
    const packed = encodeSummary(s).length;
    expect(raw).toBeGreaterThan(11_000);
    expect(packed).toBeLessThan(raw / 4);
  });
});

describe('world cache: seen marks (Track Z, ore memory)', () => {
  const IRON_AT = { x: 5, y: -49, z: 5 };
  const COAL_AT = { x: 3, y: -50, z: 3 };

  it('flags a mark seen, keeps it through same-block updates, drops it with the block', () => {
    const { src, cache } = setup();
    expect(cache.markSeen(IRON_AT, 'iron_ore')).toBe(true);
    expect(cache.markSeen(IRON_AT, 'coal_ore')).toBe(false); // another name: no such mark
    expect(cache.markSeen({ x: 6, y: -49, z: 6 }, 'iron_ore')).toBe(false);
    expect(cache.seenMarks({ x: 0, y: -49, z: 0 }, 32)).toEqual([{ ...IRON_AT, name: 'iron_ore', exposed: true, seen: true }]);
    expect(cache.loadedMarks({ x: 0, y: -49, z: 0 }, 32).some((m) => m.name === 'coal_ore')).toBe(true);
    src.emit('update_block', { position: IRON_AT, block_runtime_id: IRON, flags: {}, layer: 0 });
    expect(cache.seenMarks({ x: 0, y: -49, z: 0 }, 32)).toHaveLength(1);
    src.emit('update_block', { position: IRON_AT, block_runtime_id: STONE, flags: {}, layer: 0 });
    expect(cache.seenMarks({ x: 0, y: -49, z: 0 }, 32)).toHaveLength(0);
  });

  it('survives a restart: on disk (bit 1 of the flags), carried onto the column when it loads again, and from unloaded columns', () => {
    const dir = tmp();
    const a = setup(dir);
    a.cache.markSeen(IRON_AT, 'iron_ore');
    expect(a.cache.markSeen(COAL_AT, 'coal_ore')).toBe(true); // buried, but the memory decides that
    a.cache.close();
    // unloaded: a fresh reader sees the flags
    const fresh = new WorldCache({ dir, readOnly: true, logger: silentLogger });
    const marks = fresh.cachedSummary(0, 0)!.markList().filter((m) => m.seen);
    expect(marks.map((m) => m.name).sort()).toEqual(['coal_ore', 'iron_ore']);
    expect(fresh.seenMarks({ x: 0, y: -49, z: 0 }, 32)).toHaveLength(2);
    // a new process: the column loads again and keeps the flags (decodeSeenMarks from the record)
    const b = setup(dir);
    expect(b.cache.liveSummary(0, 0)!.markList().filter((m) => m.seen)).toHaveLength(2);
    expect(b.cache.stats.seenCarried).toBe(2);
    expect(b.cache.seenMarks({ x: 0, y: -49, z: 0 }, 32)).toHaveLength(2);
    // the record still decodes for readers that only know bit 0
    const s = decodeSummary(encodeSummary(b.cache.liveSummary(0, 0)!));
    expect(s.markList().find((m) => m.name === 'iron_ore')).toMatchObject({ exposed: true, seen: true });
  });
});

describe('log clusters (Track Z, find.ts)', () => {
  it('groups logs within 6 blocks, nearest cluster first, skips blacklisted logs', async () => {
    const { logClusters, findLogClusters } = await import('../../../src/world/find.ts');
    const at = (x: number, y: number, z: number, cached?: true) => ({ x, y, z, ...(cached ? { cached } : {}) });
    const logs = [at(0, 0, 0), at(0, 1, 0), at(4, 0, 3), at(100, 64, 0, true), at(103, 64, 2, true), at(40, 0, 40)];
    const c = logClusters(logs, { x: 90, y: 64, z: 0 });
    expect(c.map((k) => k.logs.length)).toEqual([2, 1, 3]);
    expect(c[0]!.cached).toBe(2);
    expect(c[0]!.distance).toBeCloseTo(Math.hypot(10.5, 0.5, 0.5), 5);
    const world = { find: () => logs };
    expect(findLogClusters(world, { x: 0, y: 0, z: 0 }, 200, { skip: (p) => p.x >= 100 }).map((k) => k.logs.length)).toEqual([3, 1]);
  });
});
