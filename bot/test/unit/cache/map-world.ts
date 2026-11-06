// The map tests' world (decision 0062: shared by cache/map.test.ts and cache/map-live.test.ts): a
// replayed login with 3 x 3 chunks and a world cache in a temporary directory.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../../../src/log.ts';
import { WorldCache } from '../../../src/world/cache/index.ts';
import { World } from '../../../src/world/index.ts';
import { encodeSubChunk, fillSection, readyRegistry, recordedLogin, ReplaySource } from '../world/helpers.ts';

const dirs: string[] = [];
/** Removes the cache directories of the worlds made so far (call it in afterEach). */
export function cleanMapWorlds(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

const reg = readyRegistry();
export const rid = (name: string): number => reg.runtimeIdOf(reg.stateIdOf(name)!);

/** A world of 3 x 3 loaded chunks around 0 0 (stone to y -50, then stone with water in the first 4 columns of chunk 1 0) and its world cache; the bot at 4.5 -48 4.5, a zombie at 10 -48 3. */
export function world3x3() {
  const src = new ReplaySource();
  const world = new World(src, { logger: silentLogger, defer: (fn) => fn() });
  const { startGame, itemRegistry } = recordedLogin();
  src.emit('start_game', startGame);
  src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
  src.emit('network_chunk_publisher_update', { coordinates: { x: 8, y: 0, z: 8 }, radius: 32, saved_chunks: [] });
  const dir = mkdtempSync(join(tmpdir(), 'bb-map-'));
  dirs.push(dir);
  const cache = new WorldCache({ dir, flushIntervalMs: 0, logger: silentLogger });
  cache.attach(world);
  const stone = rid('stone');
  const water = rid('water');
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      src.emit('level_chunk', { x: cx, z: cz, dimension: 0, sub_chunk_count: 0, highest_subchunk_count: 1, cache_enabled: false, blobs: [], payload: Buffer.alloc(0) });
      const sec = fillSection((x, y) => (y < 15 ? stone : cx === 1 && x < 4 ? water : stone));
      src.emit('subchunk', { cache_enabled: false, dimension: 0, origin: { x: cx, y: -4, z: cz }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: encodeSubChunk([sec], { y: -4 }) }] });
    }
  }
  world.self.pos = { x: 4.5, y: -48, z: 4.5 };
  world.entityTracker.entities.set(5n, {
    runtimeId: 5n,
    uniqueId: 5n,
    type: 'minecraft:zombie',
    pos: { x: 10, y: -48, z: 3 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    headYaw: 0,
    onGround: true,
    updatedAt: 0,
  });
  return { src, world, cache };
}
