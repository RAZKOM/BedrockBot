// The 5 x 5 forest world of find.test.ts (PLAN.md task 2.6), shared with test/perf/find.perf.test.ts (Track REL3).
import { silentLogger } from '../../../src/log.ts';
import { World } from '../../../src/world/index.ts';
import { encodeSubChunk, fillSection, readyRegistry, recordedLogin, ReplaySource } from './helpers.ts';

export const AIR = -604749536;
const STONE = -2144268767;

/**
 * A 5 x 5 column world around the origin: a stone floor section (y -64..-49), and in the next
 * section a forest of oak logs and leaves plus a few chests. 25 columns x 4096 blocks = 102 400
 * non-air-section blocks in the scanned range.
 */
export function forestWorld(withFloor = true) {
  const reg = readyRegistry();
  const log = reg.runtimeIdOf(reg.stateIdOf('oak_log', { pillar_axis: 'y' })!);
  const leaves = reg.runtimeIdOf(reg.stateIdOf('oak_leaves')!);
  const chest = reg.runtimeIdOf(reg.stateIdOf('chest')!);
  const src = new ReplaySource();
  const world = new World(src, { logger: silentLogger, defer: (fn) => fn() });
  const { startGame, itemRegistry } = recordedLogin();
  src.emit('start_game', startGame);
  src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
  const floor = encodeSubChunk([fillSection(() => STONE)], { y: -4 });
  // Trees every 4 blocks (trunk y 0..5 of the section, leaves y 6..8), a chest at local (8, 0, 8).
  const forest = encodeSubChunk(
    [
      fillSection((x, y, z) => {
        if (x === 8 && z === 8 && y === 0) return chest;
        const trunk = x % 4 === 1 && z % 4 === 1;
        if (trunk && y <= 5) return log;
        if (y >= 6 && y <= 8 && (x % 4 !== 3 || z % 4 !== 3)) return leaves;
        return AIR;
      }),
    ],
    { y: -3 },
  );
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) {
      src.emit('level_chunk', { x: cx, z: cz, dimension: 0, sub_chunk_count: 0, highest_subchunk_count: 2, cache_enabled: false, blobs: [], payload: Buffer.alloc(0) });
      src.emit('subchunk', {
        cache_enabled: false,
        dimension: 0,
        origin: { x: cx, y: -4, z: cz },
        entries: [
          withFloor ? { dx: 0, dy: 0, dz: 0, result: 'success', payload: floor } : { dx: 0, dy: 0, dz: 0, result: 'success_all_air' },
          { dx: 0, dy: 1, dz: 0, result: 'success', payload: forest },
        ],
      });
    }
  }
  return { src, world, log, chest };
}
