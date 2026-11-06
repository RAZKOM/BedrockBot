// Track PC (decision 0060): the surface layer of the world cache. What a column's surface is (flowers
// count, glass and torches are looked through, liquids get a floor and a depth), encode / decode round
// trips, records written before the layer (no trailer) and older readers of new records, updates on
// block changes, the Nether's under-roof layer, and the rules that guard it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import { StateTable, mapView, VIS_BLOCK, VIS_LIQUID, VIS_NONE } from '../../../src/world/cache/classes.ts';
import { decodeSeenMarks, decodeSummary, encodeRaw, encodeSummary } from '../../../src/world/cache/summary.ts';
import { MAX_NAMES, NO_NAME, roofedDimension, scanTop, scanUnderRoof, SURFACE_TAG, SurfaceData } from '../../../src/world/cache/surface.ts';
import { WorldCache, regionOf, slotOf } from '../../../src/world/cache/index.ts';
import { writeRegionSync } from '../../../src/world/cache/region.ts';
import { World } from '../../../src/world/index.ts';
import { encodeSubChunk, fillSection, readyRegistry, recordedLogin, ReplaySource } from '../world/helpers.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bb-surface-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const reg = readyRegistry();
const sid = (name: string, states?: Record<string, unknown>): number => {
  const s = reg.stateIdOf(name, states);
  if (s === undefined) throw new Error(`no state ${name}`);
  return s;
};
const rid = (name: string, states?: Record<string, unknown>): number => reg.runtimeIdOf(sid(name, states));
const table = new StateTable(reg);
const facts = (s: number) => table.of(s);

/**
 * Section 0 (y -64..-49) of the overworld test column: stone to -52, then per column (x, z = 0):
 *   x 0  grass_block -51, poppy -50                    -> poppy at -50
 *   x 1  sand -52, water -51..-49                      -> water at -49, 3 deep over sand
 *   x 2  stone -51, glass -50                          -> stone at -51 (glass looked through)
 *   x 3  stone -51, torch -50                          -> stone at -51
 *   x 4  nothing above -52                             -> stone at -52
 *   x 5  sand -51, seagrass -50, water -49             -> water at -49, 2 deep over sand
 *   x 6  grass_block -51, snow_layer -50               -> snow_layer at -50
 *   else grass_block -51                               -> grass_block at -51
 */
function overworldSection(): number[] {
  const S = (n: string) => rid(n);
  const stone = S('stone');
  const grass = S('grass_block');
  const air = S('air');
  return fillSection((x, y, z) => {
    const wy = -64 + y;
    if (wy <= -52) return x === 1 && z === 0 && wy === -52 ? S('sand') : stone;
    if (z !== 0) return wy === -51 ? grass : air;
    switch (x) {
      case 0:
        return wy === -51 ? grass : wy === -50 ? S('poppy') : air;
      case 1:
        return S('water');
      case 2:
        return wy === -51 ? stone : wy === -50 ? S('glass') : air;
      case 3:
        return wy === -51 ? stone : wy === -50 ? S('torch') : air;
      case 4:
        return air;
      case 5:
        return wy === -51 ? S('sand') : wy === -50 ? S('seagrass') : S('water');
      case 6:
        return wy === -51 ? grass : wy === -50 ? S('snow_layer') : air;
      default:
        return wy === -51 ? grass : air;
    }
  });
}

function newWorld(): { src: ReplaySource; world: World } {
  const src = new ReplaySource();
  const world = new World(src, { logger: silentLogger, defer: (fn) => fn() });
  const { startGame, itemRegistry } = recordedLogin();
  src.emit('start_game', startGame);
  src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
  src.emit('network_chunk_publisher_update', { coordinates: { x: 8, y: 0, z: 8 }, radius: 32, saved_chunks: [] });
  return { src, world };
}

function overworld(dir = tmp()) {
  const { src, world } = newWorld();
  const cache = new WorldCache({ dir, flushIntervalMs: 0, logger: silentLogger });
  cache.attach(world);
  src.emit('level_chunk', { x: 0, z: 0, dimension: 0, sub_chunk_count: 0, highest_subchunk_count: 1, cache_enabled: false, blobs: [], payload: Buffer.alloc(0) });
  src.emit('subchunk', { cache_enabled: false, dimension: 0, origin: { x: 0, y: -4, z: 0 }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: encodeSubChunk([overworldSection()], { y: -4 }) }] });
  return { src, world, cache, dir };
}

describe('surface layer: what a column shows', () => {
  it('maps blocks: liquids by fluid, see-through blocks, visible blocks without a box', () => {
    const view = (n: string) => mapView(n, { liquid: undefined });
    expect(mapView('kelp', { liquid: 'water' })).toEqual({ vis: VIS_LIQUID, name: 'water' });
    expect(mapView('flowing_lava', { liquid: 'lava' })).toEqual({ vis: VIS_LIQUID, name: 'lava' });
    for (const n of ['air', 'glass', 'glass_pane', 'torch', 'soul_torch', 'redstone_torch', 'stone_button', 'lever', 'light_block_7', 'barrier', 'structure_void']) expect(view(n).vis, n).toBe(VIS_NONE);
    for (const n of ['poppy', 'short_grass', 'snow_layer', 'white_carpet', 'rail', 'stone', 'oak_leaves', 'red_stained_glass']) expect(view(n).vis, n).toBe(VIS_BLOCK);
    expect(table.of(sid('seagrass'))).toMatchObject({ vis: VIS_LIQUID, mapName: 'water' });
  });

  it('records the surface, floor and depth of every column when a column loads', () => {
    const { cache } = overworld();
    const s = cache.liveSummary(0, 0)!;
    expect(s.surf).toBeDefined();
    expect(s.surf!.under).toBeUndefined(); // overworld: no under-roof layer
    expect(s.surfaceAt(0, 0)).toEqual({ name: 'poppy', y: -50 });
    expect(s.surfaceAt(1, 0)).toEqual({ name: 'water', y: -49, depth: 3, floor: 'sand', floorY: -52 });
    expect(s.surfaceAt(2, 0)).toEqual({ name: 'stone', y: -51 });
    expect(s.surfaceAt(3, 0)).toEqual({ name: 'stone', y: -51 });
    expect(s.surfaceAt(4, 0)).toEqual({ name: 'stone', y: -52 });
    expect(s.surfaceAt(5, 0)).toEqual({ name: 'water', y: -49, depth: 2, floor: 'sand', floorY: -51 });
    expect(s.surfaceAt(6, 0)).toEqual({ name: 'snow_layer', y: -50 });
    expect(s.surfaceAt(9, 9)).toEqual({ name: 'grass_block', y: -51 });
    expect(s.surfaceAt(0, 0, 'under')).toBeUndefined();
    // the planner's arrays are what they were: the poppy is no top, the glass is
    expect(s.top[0]).toBe(-51);
    expect(s.top[2]).toBe(-50);
  });

  it('keeps the surface current on block updates', () => {
    const { src, cache } = overworld();
    const s = cache.liveSummary(0, 0)!;
    const rev0 = s.rev;
    src.emit('update_block', { position: { x: 9, y: -50, z: 9 }, block_runtime_id: rid('poppy'), flags: {}, layer: 0 });
    expect(s.surfaceAt(9, 9)).toEqual({ name: 'poppy', y: -50 });
    expect(s.rev).toBeGreaterThan(rev0);
    src.emit('update_block', { position: { x: 9, y: -50, z: 9 }, block_runtime_id: rid('air'), flags: {}, layer: 0 });
    expect(s.surfaceAt(9, 9)).toEqual({ name: 'grass_block', y: -51 });
    // glass above the stored rows: still grass; stone up there: the new surface
    src.emit('update_block', { position: { x: 9, y: -30, z: 9 }, block_runtime_id: rid('glass'), flags: {}, layer: 0 });
    expect(s.surfaceAt(9, 9)).toEqual({ name: 'grass_block', y: -51 });
    src.emit('update_block', { position: { x: 9, y: -29, z: 9 }, block_runtime_id: rid('stone'), flags: {}, layer: 0 });
    expect(s.surfaceAt(9, 9)).toEqual({ name: 'stone', y: -29 });
    // draining the pool: sand is the surface
    for (const y of [-49, -50, -51]) src.emit('update_block', { position: { x: 1, y, z: 0 }, block_runtime_id: rid('air'), flags: {}, layer: 0 });
    expect(s.surfaceAt(1, 0)).toEqual({ name: 'sand', y: -52 });
    // and the map tile follows
    expect(cache.tile(0, 0)!.surf!.read(cache.tile(0, 0)!.surf!.top, 1)).toEqual({ name: 'sand', y: -52 });
  });
});

describe('surface layer: records', () => {
  it('round-trips through encode / decode, and the checksum covers it', () => {
    const { cache } = overworld();
    const s = cache.liveSummary(0, 0)!;
    const d = decodeSummary(encodeSummary(s));
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) expect(d.surfaceAt(x, z), `${x},${z}`).toEqual(s.surfaceAt(x, z));
    expect(d.checksum()).toBe(s.checksum());
    const before = s.checksum();
    s.surf!.set(s.surf!.top, 9 * 16 + 9, { name: 'poppy', y: -50, floor: undefined, depth: 0 });
    expect(s.checksum()).not.toBe(before);
  });

  it('reads records written before the layer (no trailer): no surface data, everything else intact', () => {
    const { cache, dir } = overworld();
    const s = cache.liveSummary(0, 0)!;
    const old = decodeSummary(encodeSummary(s));
    old.surf = undefined;
    const rec = encodeSummary(old);
    const back = decodeSummary(rec);
    expect(back.surf).toBeUndefined();
    expect(back.surfaceAt(0, 0)).toBeUndefined();
    expect(Array.from(back.top)).toEqual(Array.from(s.top));
    // a fresh cache over a region holding the old record: a tile without surface data
    const dir2 = tmp();
    writeRegionSync(dir2, regionOf(0), regionOf(0), new Map([[slotOf(0, 0), rec]]));
    const reader = new WorldCache({ dir: dir2, readOnly: true, logger: silentLogger });
    const t = reader.tile(0, 0)!;
    expect(t.surf).toBeUndefined();
    expect(t.y[0]).toBe(-51);
    expect(dir).not.toBe(dir2);
  });

  it('new records stay readable by a reader that stops after the marks (record version 1, trailer tag after the marks)', () => {
    const { cache } = overworld();
    const s = cache.liveSummary(0, 0)!;
    const raw = Buffer.from(encodeRaw(s));
    expect(raw.readUInt8(0)).toBe(1); // the record version did not change
    // walk the version-1 layout to the end of the marks: the trailer tag follows
    const rows = raw.readUInt16LE(19);
    let o = 21 + 1024 + rows * 64;
    const names = raw.readUInt16LE(o);
    o += 2;
    for (let i = 0; i < names; i++) o += 1 + raw.readUInt8(o);
    o += 4 + raw.readUInt32LE(o) * 6;
    expect(raw.readUInt8(o)).toBe(SURFACE_TAG);
    expect(() => decodeSeenMarks(encodeSummary(s))).not.toThrow();
  });

  it('a damaged trailer costs the surface, not the chunk', () => {
    const { cache } = overworld();
    const s = cache.liveSummary(0, 0)!;
    const raw = Buffer.from(encodeRaw(s));
    const cut = raw.subarray(0, raw.length - 300); // truncated inside the top layer
    const d = decodeSummary(deflateRawSync(cut));
    expect(d.surf).toBeUndefined();
    expect(d.top[0]).toBe(-51);
  });

  it('the name table holds 255 names; more read as nothing', () => {
    const d = new SurfaceData(false);
    for (let i = 0; i < MAX_NAMES; i++) expect(d.nameId(`block_${i}`)).toBe(i);
    expect(d.nameId('one_too_many')).toBe(NO_NAME);
    d.set(d.top, 0, { name: 'one_too_many', y: 5, floor: undefined, depth: 0 });
    expect(d.read(d.top, 0)).toBeUndefined();
  });

  it('compacts unused names on encode (a block update that replaced the only poppy)', () => {
    const { src, cache } = overworld();
    const s = cache.liveSummary(0, 0)!;
    src.emit('update_block', { position: { x: 0, y: -50, z: 0 }, block_runtime_id: rid('air'), flags: {}, layer: 0 });
    expect(s.surf!.names).toContain('poppy');
    expect(decodeSummary(encodeSummary(s)).surf!.names).not.toContain('poppy');
  });
});

describe('surface layer: the Nether (under the roof)', () => {
  const S = (n: string) => sid(n);
  /** A Nether column by y: bedrock roof 123..127, netherrack 100..122 with a one-cell slit at 110, weeping vines hanging 95..99, open down to `floor` at 40 (with `plant` on it), netherrack below; `lavaTo`: open down to a lava sea 21..lavaTo instead. */
  function nether(y: number, o: { floor?: string; plant?: string; lavaTo?: number } = {}): number {
    if (y >= 123) return S('bedrock');
    if (y === 110) return S('air'); // a one-cell slit inside the roof: more roof, not a floor
    if (y >= 100) return S('netherrack');
    if (y >= 95) return S('weeping_vines');
    if (o.lavaTo !== undefined) return y > o.lavaTo ? S('air') : y > 20 ? S('lava') : S('netherrack');
    if (y === 41 && o.plant) return S(o.plant);
    if (y > 40) return S('air');
    if (y === 40) return S(o.floor ?? 'netherrack');
    return S('netherrack');
  }

  it('is a roofed dimension; the top layer is the roof itself', () => {
    expect(roofedDimension(1)).toBe(true);
    expect(roofedDimension(0)).toBe(false);
    expect(roofedDimension(2)).toBe(false);
    expect(scanTop((y) => nether(y), facts, 127, 0)).toMatchObject({ name: 'bedrock', y: 127 });
  });

  it('finds the first standable floor under the roof: past slits and hanging vines, the plant on it shown', () => {
    expect(scanUnderRoof((y) => nether(y), facts, 127, 0)).toEqual({ name: 'netherrack', y: 40, floor: undefined, depth: 0 });
    expect(scanUnderRoof((y) => nether(y, { floor: 'crimson_nylium', plant: 'crimson_roots' }), facts, 127, 0)).toEqual({ name: 'crimson_roots', y: 41, floor: undefined, depth: 0 });
    // the lava sea: a liquid surface, its floor and depth
    expect(scanUnderRoof((y) => nether(y, { lavaTo: 31 }), facts, 127, 0)).toEqual({ name: 'lava', y: 31, floor: 'netherrack', depth: 11 });
    // a two-high pocket inside the roof counts (the rule is two open cells)
    const pocket = (y: number) => (y === 115 || y === 116 ? S('air') : nether(y));
    expect(scanUnderRoof(pocket, facts, 127, 0)).toMatchObject({ name: 'netherrack', y: 114 });
    // solid all the way: nothing
    expect(scanUnderRoof(() => S('netherrack'), facts, 127, 0)).toBeUndefined();
  });

  it('records the under-roof layer for columns loaded in the Nether and keeps it through a round trip', () => {
    const { src, world } = newWorld();
    const cache = new WorldCache({ dir: tmp(), flushIntervalMs: 0, logger: silentLogger });
    cache.attach(world);
    src.emit('change_dimension', { dimension: 1, position: { x: 8, y: 70, z: 8 }, respawn: false });
    src.emit('network_chunk_publisher_update', { coordinates: { x: 8, y: 0, z: 8 }, radius: 32, saved_chunks: [] });
    src.emit('level_chunk', { x: 0, z: 0, dimension: 1, sub_chunk_count: 0, highest_subchunk_count: 8, cache_enabled: false, blobs: [], payload: Buffer.alloc(0) });
    const R = (st: number) => reg.runtimeIdOf(st);
    const entries = [];
    for (let dy = 0; dy < 8; dy++) entries.push({ dx: 0, dy, dz: 0, result: 'success', payload: encodeSubChunk([fillSection((x, y) => R(nether(dy * 16 + y, x === 0 ? { floor: 'crimson_nylium', plant: 'crimson_roots' } : x === 1 ? { lavaTo: 31 } : {})))], { y: dy }) });
    src.emit('subchunk', { cache_enabled: false, dimension: 1, origin: { x: 0, y: 0, z: 0 }, entries });
    expect(world.chunks.dimension).toBe(1);
    const s = cache.liveSummary(0, 0)!;
    expect(s.surf?.under).toBeDefined();
    expect(s.surfaceAt(5, 5)).toMatchObject({ name: 'bedrock', y: 127 });
    expect(s.surfaceAt(0, 3, 'under')).toEqual({ name: 'crimson_roots', y: 41 });
    expect(s.surfaceAt(1, 3, 'under')).toEqual({ name: 'lava', y: 31, depth: 11, floor: 'netherrack', floorY: 20 });
    expect(s.surfaceAt(5, 5, 'under')).toEqual({ name: 'netherrack', y: 40 });
    const d = decodeSummary(encodeSummary(s));
    for (const [x, z] of [[0, 3], [1, 3], [5, 5]] as const) expect(d.surfaceAt(x, z, 'under')).toEqual(s.surfaceAt(x, z, 'under'));
    // a block update under the roof moves the under layer
    src.emit('update_block', { position: { x: 5, y: 41, z: 5 }, block_runtime_id: R(S('netherrack')), flags: {}, layer: 0 });
    expect(s.surfaceAt(5, 5, 'under')).toEqual({ name: 'netherrack', y: 41 });
  });
});
