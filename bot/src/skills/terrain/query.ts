// Adapters from a block source (the world model, or a generated test world) to the movement
// model's BlockQuery and the pathfinder's cell queries.
import type { World } from '../../world/index.ts';
import type { BlockInfo } from '../../world/types.ts';
import type { BlockQuery } from '../input/types.ts';
import { classify, type TerrainClass } from './classify.ts';

/** Blocks by integer position; undefined = not loaded. */
export interface TerrainSource {
  blockAt(x: number, y: number, z: number): BlockInfo | undefined;
}

/** The parts of the world model (`World`) a TerrainSource reads. */
export interface BlockStore {
  chunks: Pick<World['chunks'], 'stateIdAt' | 'runtimeIdAt'>;
  registry: Pick<World['registry'], 'blockInfo'>;
}

/** The world model as a TerrainSource (layer 0, straight from the chunk store, no Vec3 allocation). */
export function worldSource(world: BlockStore): TerrainSource {
  const { chunks, registry } = world;
  return {
    blockAt(x, y, z) {
      const s = chunks.stateIdAt(x, y, z);
      if (s === undefined) return undefined;
      return registry.blockInfo(s, s < 0 ? (chunks.runtimeIdAt(x, y, z) ?? 0) : 0);
    },
  };
}

/** Classification at a position, undefined when not loaded. */
export function classAt(src: TerrainSource, x: number, y: number, z: number): TerrainClass | undefined {
  const b = src.blockAt(x, y, z);
  return b && classify(b);
}

/** The movement model's view of a TerrainSource: real collision shapes, friction and liquids. */
export function blockQueryOf(src: TerrainSource): BlockQuery {
  return {
    solidAt(x, y, z) {
      const c = classAt(src, x, y, z);
      return c && c.boxes.length > 0;
    },
    boxesAt(x, y, z) {
      return classAt(src, x, y, z)?.boxes;
    },
    frictionAt(x, y, z) {
      return classAt(src, x, y, z)?.friction;
    },
    liquidAt(x, y, z) {
      const c = classAt(src, x, y, z);
      if (!c) return undefined;
      return c.liquid ? { liquid: c.liquid, height: c.liquidHeight } : null;
    },
  };
}
