// Chunk store and block updates (PLAN.md tasks 2.2 and 2.3) on synthetic packets.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import { World, type WorldOptions } from '../../../src/world/index.ts';
import { encodeSubChunk, fillSection, recordedLogin, ReplaySource } from './helpers.ts';

const AIR = -604749536;
const BEDROCK = -173245189;
const DIRT = -2108756090;
const GRASS = -567203660;
const OAK_LOG_Y = 825916963;
const STONE = -2144268767;

/** Flat-world bottom section: bedrock, dirt, dirt, grass, air above. */
const FLAT = fillSection((_x, y) => [BEDROCK, DIRT, DIRT, GRASS][y] ?? AIR);

interface Harness {
  src: ReplaySource;
  world: World;
  clock: { t: number };
  runDeferred: () => void;
  requests: () => { origin: { x: number; y: number; z: number }; requests: { x: number; y: number; z: number }[] }[];
}

function setup(opts: WorldOptions = {}, login = true): Harness {
  const src = new ReplaySource();
  const clock = { t: 0 };
  const deferred: (() => void)[] = [];
  const world = new World(src, { logger: silentLogger, now: () => clock.t, defer: (fn) => deferred.push(fn), ...opts });
  if (login) {
    const { startGame, itemRegistry } = recordedLogin();
    src.emit('start_game', startGame);
    src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
  }
  return {
    src,
    world,
    clock,
    runDeferred: () => {
      while (deferred.length) deferred.shift()!();
    },
    requests: () =>
      src.sent.filter((s) => s.name === 'subchunk_request').map((s) => s.params as ReturnType<Harness['requests']>[number]),
  };
}

function levelChunk(x: number, z: number, highest = 1, dimension = 0) {
  return { x, z, dimension, sub_chunk_count: 0, highest_subchunk_count: highest, cache_enabled: false, blobs: [], payload: Buffer.alloc(0) };
}

/** Answer every requested subchunk: index 0 = flat section, others all air. */
function answerAll(h: Harness, from = 0): void {
  for (const r of h.requests().slice(from)) {
    h.src.emit('subchunk', {
      cache_enabled: false,
      dimension: 0,
      origin: r.origin,
      entries: r.requests.map((q) => ({
        dx: q.x,
        dy: q.y,
        dz: q.z,
        result: q.y === 0 ? 'success' : 'success_all_air',
        payload: q.y === 0 ? encodeSubChunk([FLAT], { y: r.origin.y + q.y }) : undefined,
      })),
    });
  }
}

describe('ChunkStore', () => {
  it('batches level_chunks into few subchunk_requests with column offsets, origin y = -4', () => {
    const h = setup();
    h.src.emit('network_chunk_publisher_update', { coordinates: { x: 0, y: -60, z: 0 }, radius: 64, saved_chunks: [] });
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 2; z++) h.src.emit('level_chunk', levelChunk(x, z, 2));
    expect(h.requests()).toHaveLength(0); // deferred until the burst is over
    h.runDeferred();
    const reqs = h.requests();
    expect(reqs).toHaveLength(2); // 12 columns, 8 per packet
    expect(reqs[0]!.origin).toEqual({ x: 0, y: -4, z: 0 }); // closest column first
    expect(reqs[0]!.requests).toHaveLength(16);
    expect(reqs[0]!.requests).toContainEqual({ x: -1, y: 1, z: -1 });
    const total = reqs.reduce((n, r) => n + r.requests.length, 0);
    expect(total).toBe(24);
    expect(h.world.chunks.pendingCount).toBe(12);
  });

  it('caps outstanding columns and sends more as answers arrive', () => {
    const h = setup({ maxOutstanding: 4, batchColumns: 2 });
    for (let x = 0; x < 12; x++) h.src.emit('level_chunk', levelChunk(x, 0));
    h.runDeferred();
    expect(h.requests()).toHaveLength(2);
    answerAll(h);
    h.runDeferred();
    expect(h.requests()).toHaveLength(4);
    answerAll(h, 2);
    h.runDeferred();
    answerAll(h, 4);
    h.runDeferred();
    expect(h.world.chunks.loadedCount).toBe(12);
    expect(h.world.chunks.pendingCount).toBe(0);
  });

  it('decodes success, success_all_air and y_index_out_of_bounds; loaded only when complete', () => {
    const h = setup();
    h.src.emit('level_chunk', levelChunk(0, 0, 3));
    h.runDeferred();
    const [r] = h.requests();
    expect(r!.requests.map((q) => q.y)).toEqual([0, 1, 2]);
    const answer = (dy: number, result: string) =>
      h.src.emit('subchunk', {
        cache_enabled: false,
        dimension: 0,
        origin: r!.origin,
        entries: [{ dx: 0, dy, dz: 0, result, payload: result === 'success' ? encodeSubChunk([FLAT], { y: -4 + dy }) : undefined }],
      });
    answer(0, 'success');
    expect(h.world.isLoaded(0, 0)).toBe(false);
    expect(h.world.blockAt({ x: 3, y: -61, z: 3 })).toBeUndefined();
    answer(1, 'success_all_air');
    answer(2, 'y_index_out_of_bounds');
    expect(h.world.isLoaded(0, 0)).toBe(true);
    expect(h.world.blockAt({ x: 3, y: -64, z: 3 })?.name).toBe('bedrock');
    expect(h.world.blockAt({ x: 15, y: -63, z: 0 })?.name).toBe('dirt');
    expect(h.world.blockAt({ x: 3.7, y: -59.5, z: 3.2 })?.name).toBe('air');
    expect(h.world.blockAt({ x: 3, y: -61, z: 3 })?.name).toBe('grass_block');
    expect(h.world.blockAt({ x: 3, y: -40, z: 3 })?.name).toBe('air'); // all-air section
    expect(h.world.blockAt({ x: 3, y: 300, z: 3 })?.name).toBe('air'); // above highest_subchunk_count
    expect(h.world.blockAt({ x: 3, y: -70, z: 3 })?.name).toBe('air'); // below the world
    expect(h.world.blockAt({ x: 16, y: -61, z: 0 })).toBeUndefined(); // neighbour column unknown
    expect(h.world.chunks.stats.entries).toEqual({ success: 1, success_all_air: 1, y_index_out_of_bounds: 1 });
  });

  it('drops a column on chunk_not_found', () => {
    const h = setup();
    h.src.emit('level_chunk', levelChunk(5, 5));
    h.runDeferred();
    const [r] = h.requests();
    h.src.emit('subchunk', { cache_enabled: false, dimension: 0, origin: r!.origin, entries: [{ dx: 0, dy: 0, dz: 0, result: 'chunk_not_found' }] });
    expect(h.world.chunks.column(5, 5)).toBeUndefined();
    expect(h.world.isLoaded(5, 5)).toBe(false);
    expect(h.world.chunks.pendingCount).toBe(0);
  });

  it('re-requests a column whose answer timed out', () => {
    const h = setup({ requestTimeoutMs: 5000 });
    h.src.emit('level_chunk', levelChunk(1, 1));
    h.runDeferred();
    expect(h.requests()).toHaveLength(1);
    h.clock.t = 4000;
    h.src.step();
    expect(h.requests()).toHaveLength(1);
    h.clock.t = 5001;
    h.src.step();
    expect(h.requests()).toHaveLength(2);
    expect(h.world.chunks.stats.retries).toBe(1);
    answerAll(h, 1);
    expect(h.world.isLoaded(1, 1)).toBe(true);
  });

  it('unloads columns beyond the distance from the publisher center', () => {
    const h = setup({ unloadDistance: 2 });
    const unloaded: string[] = [];
    h.world.chunks.onColumnUnloaded((cx, cz) => unloaded.push(`${cx},${cz}`));
    for (let x = 0; x <= 2; x++) h.src.emit('level_chunk', levelChunk(x, 0));
    h.runDeferred();
    answerAll(h);
    expect(h.world.chunks.loadedCount).toBe(3);
    // A column outside the distance is not even kept.
    h.src.emit('level_chunk', levelChunk(9, 0));
    expect(h.world.chunks.column(9, 0)).toBeUndefined();
    // The player moves to x = 64 (chunk 4): columns 0 and 1 are now more than 2 chunks away.
    h.src.emit('network_chunk_publisher_update', { coordinates: { x: 64, y: -60, z: 0 }, radius: 32, saved_chunks: [] });
    expect(unloaded.sort()).toEqual(['0,0', '1,0']);
    expect(h.world.isLoaded(2, 0)).toBe(true);
    expect(h.world.blockAt({ x: 0, y: -61, z: 0 })).toBeUndefined();
  });

  it('defaults the unload distance to the publisher radius + 2 chunks', () => {
    const h = setup();
    h.src.emit('network_chunk_publisher_update', { coordinates: { x: 0, y: 0, z: 0 }, radius: 160, saved_chunks: [] });
    expect(h.world.chunks.unloadDistance).toBe(12);
    h.world.chunks.setCenter({ x: 1000, y: 0, z: 0 });
    expect(h.world.chunks.size).toBe(0);
  });

  it('holds level_chunk until the registry is ready (item_registry after start_game)', () => {
    const h = setup({}, false);
    const { startGame, itemRegistry } = recordedLogin();
    h.src.emit('start_game', startGame);
    h.src.emit('level_chunk', levelChunk(0, 0));
    h.runDeferred();
    expect(h.requests()).toHaveLength(0);
    expect(h.world.chunks.size).toBe(0);
    h.src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
    h.runDeferred();
    expect(h.requests()).toHaveLength(1);
    answerAll(h);
    expect(h.world.blockAt({ x: 0, y: -61, z: 0 })?.name).toBe('grass_block');
  });

  it('builds the registry at player_spawn when item_registry never came', () => {
    const h = setup({}, false);
    h.src.emit('start_game', recordedLogin().startGame);
    h.src.emit('level_chunk', levelChunk(0, 0));
    h.src.emit('play_status', { status: 'player_spawn' });
    h.runDeferred();
    answerAll(h);
    expect(h.world.blockAt({ x: 0, y: -64, z: 0 })?.name).toBe('bedrock');
  });

  it('ignores other dimensions and clears on change_dimension', () => {
    const h = setup();
    h.src.emit('level_chunk', levelChunk(0, 0, 1, 1));
    expect(h.world.chunks.size).toBe(0);
    h.src.emit('level_chunk', levelChunk(0, 0));
    h.runDeferred();
    answerAll(h);
    expect(h.world.isLoaded(0, 0)).toBe(true);
    h.src.emit('change_dimension', { dimension: 1, position: { x: 0, y: 70, z: 0 }, respawn: false });
    expect(h.world.chunks.size).toBe(0);
    expect(h.world.self.dimension).toBe(1);
    expect(h.world.chunks.minY).toBe(0);
    h.src.emit('level_chunk', levelChunk(0, 0, 1, 1));
    h.runDeferred();
    expect(h.requests().at(-1)?.origin).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('decodes legacy level_chunk payloads that carry their sections', () => {
    const h = setup();
    const payload = Buffer.concat([encodeSubChunk([FLAT], { y: -4 }), encodeSubChunk([fillSection(() => STONE)], { y: -3 })]);
    h.src.emit('level_chunk', { ...levelChunk(2, 2), sub_chunk_count: 2, highest_subchunk_count: undefined, payload });
    expect(h.world.isLoaded(2, 2)).toBe(true);
    expect(h.world.blockAt({ x: 32, y: -61, z: 32 })?.name).toBe('grass_block');
    expect(h.world.blockAt({ x: 40, y: -40, z: 40 })?.name).toBe('stone');
  });

  it('records an undecodable subchunk as air and counts the error', () => {
    const h = setup();
    h.src.emit('level_chunk', levelChunk(0, 0));
    h.runDeferred();
    const [r] = h.requests();
    h.src.emit('subchunk', { cache_enabled: false, dimension: 0, origin: r!.origin, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: Buffer.from([42]) }] });
    expect(h.world.chunks.stats.decodeErrors).toBe(1);
    expect(h.world.isLoaded(0, 0)).toBe(true);
  });
});

describe('BlockUpdates', () => {
  function loaded(): Harness {
    const h = setup();
    h.src.emit('level_chunk', levelChunk(0, 0, 2));
    h.runDeferred();
    answerAll(h);
    return h;
  }

  it('applies update_block and reports before/after', () => {
    const h = loaded();
    const events: string[] = [];
    h.world.onBlockUpdate((p, before, after) => events.push(`${p.x},${p.y},${p.z} ${before?.name}->${after.name}`));
    h.src.emit('update_block', { position: { x: 3, y: -60, z: 4 }, block_runtime_id: OAK_LOG_Y, flags: {}, layer: 0 });
    h.src.emit('update_block', { position: { x: 3, y: -61, z: 4 }, block_runtime_id: STONE, flags: {}, layer: 0 });
    // In the all-air section 1 (y -48..-33): allocates a section.
    h.src.emit('update_block', { position: { x: 0, y: -40, z: 0 }, block_runtime_id: STONE, flags: {}, layer: 0 });
    expect(h.world.blockAt({ x: 3, y: -60, z: 4 })).toMatchObject({ name: 'oak_log', states: { pillar_axis: 'y' } });
    expect(h.world.blockAt({ x: 3, y: -61, z: 4 })?.name).toBe('stone');
    expect(h.world.blockAt({ x: 0, y: -40, z: 0 })?.name).toBe('stone');
    expect(h.world.blockAt({ x: 1, y: -40, z: 0 })?.name).toBe('air');
    expect(events).toEqual(['3,-60,4 air->oak_log', '3,-61,4 grass_block->stone', '0,-40,0 air->stone']);
  });

  it('applies update_subchunk_blocks (layer 0 and the extra layer)', () => {
    const h = loaded();
    let n = 0;
    h.world.onBlockUpdate(() => n++);
    const entry = (x: number, y: number, z: number, rid: number) => ({ position: { x, y, z }, runtime_id: rid, flags: 3, entity_unique_id: 0n, transition_type: 'create' });
    h.src.emit('update_subchunk_blocks', {
      x: 0,
      y: -4,
      z: 0,
      blocks: [entry(1, -60, 1, STONE), entry(2, -60, 1, STONE), entry(3, -60, 1, OAK_LOG_Y)],
      extra: [entry(1, -60, 1, AIR)],
    });
    expect(h.world.blockAt({ x: 1, y: -60, z: 1 })?.name).toBe('stone');
    expect(h.world.blockAt({ x: 3, y: -60, z: 1 })?.name).toBe('oak_log');
    expect(h.world.chunks.stateIdAt(1, -60, 1, 1)).toBe(h.world.registry.airStateId);
    expect(n).toBe(3); // layer-1 changes do not fire onBlockUpdate
  });

  it('ignores updates for columns or sections it does not hold', () => {
    const h = setup();
    h.src.emit('level_chunk', levelChunk(0, 0));
    h.runDeferred(); // requested, not answered
    h.src.emit('update_block', { position: { x: 1, y: -60, z: 1 }, block_runtime_id: STONE, flags: {}, layer: 0 });
    h.src.emit('update_block', { position: { x: 100, y: -60, z: 1 }, block_runtime_id: STONE, flags: {}, layer: 0 });
    expect(h.world.updates.stats).toMatchObject({ updates: 0, ignored: 2 });
    answerAll(h);
    expect(h.world.blockAt({ x: 1, y: -60, z: 1 })?.name).toBe('air');
  });

  it('tracks block entities from block_entity_data and drops them when the block is replaced', () => {
    const h = loaded();
    h.src.emit('update_block', { position: { x: 4, y: -60, z: 5 }, block_runtime_id: 741882976, flags: {}, layer: 0 });
    expect(h.world.blockAt({ x: 4, y: -60, z: 5 })?.name).toBe('chest');
    h.src.emit('block_entity_data', {
      position: { x: 4, y: -60, z: 5 },
      nbt: { type: 'compound', name: '', value: { id: { type: 'string', value: 'Chest' }, x: { type: 'int', value: 4 }, y: { type: 'int', value: -60 }, z: { type: 'int', value: 5 } } },
    });
    expect(h.world.blockEntityAt({ x: 4.5, y: -60, z: 5.5 })).toEqual({ id: 'Chest', x: 4, y: -60, z: 5 });
    h.src.emit('update_block', { position: { x: 4, y: -60, z: 5 }, block_runtime_id: AIR, flags: {}, layer: 0 });
    expect(h.world.blockEntityAt({ x: 4, y: -60, z: 5 })).toBeUndefined();
  });

  it('keeps unknown runtime ids as solid "unknown" blocks and counts them', () => {
    const h = loaded();
    h.src.emit('update_block', { position: { x: 7, y: -60, z: 7 }, block_runtime_id: 99999, flags: {}, layer: 0 });
    expect(h.world.blockAt({ x: 7, y: -60, z: 7 })).toMatchObject({ name: 'unknown', solid: true, states: { runtime_id: 99999 } });
    expect(h.world.registry.unknownRuntimeIds.get(99999)).toBe(1);
  });

  it('computes the truth-pack checksum rule over the model', () => {
    const h = loaded();
    // One column of a flat world, y -64..-60: the same value truth:checksum gives for a 1x5x1 box.
    expect(h.world.checksum({ x: 0, y: -64, z: 0 }, { x: 0, y: -60, z: 0 })).toBe(
      fnv(['minecraft:bedrock', 'minecraft:dirt', 'minecraft:dirt', 'minecraft:grass_block', 'minecraft:air']),
    );
    expect(h.world.checksum({ x: 0, y: -64, z: 0 }, { x: 20, y: -60, z: 0 })).toBeUndefined(); // x 16+ not loaded
  });
});

function fnv(ids: string[]): string {
  let h = 0x811c9dc5;
  for (const s of ids) {
    for (const b of Buffer.from(s + '\0', 'ascii')) {
      h ^= b;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
