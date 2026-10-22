// Adapters from a block source (the world model, or a generated test world) to the movement
// model's BlockQuery and the pathfinder's cell queries.
import type { World } from '../../world/index.ts';
import type { BlockInfo, Box } from '../../world/types.ts';
import type { BlockQuery } from '../input/types.ts';
import { classify, type TerrainClass } from './classify.ts';
import { CONNECT_EAST, CONNECT_NORTH, CONNECT_SOUTH, CONNECT_WEST, connectedBoxes, doorBoxes } from './shapes.ts';

/** Blocks by integer position; undefined = not loaded. */
export interface TerrainSource {
  blockAt(x: number, y: number, z: number): BlockInfo | undefined;
  /**
   * Optional: the highest y of a column that may hold anything but air (the top of its highest
   * non-empty subchunk), undefined when the column is not loaded. Lets the planner find the highest
   * solid block of a column without scanning from the build limit.
   */
  columnTop?(x: number, z: number): number | undefined;
  /** Optional: the build limit (highest y). The planner's sky scan starts here without `columnTop`. */
  readonly maxY?: number;
  /** Optional: the lowest y of the world (the sky scan stops there). */
  readonly minY?: number;
}

/** The parts of the world model (`World`) a TerrainSource reads. */
export interface BlockStore {
  chunks: Pick<World['chunks'], 'stateIdAt' | 'runtimeIdAt'> & Partial<Pick<World['chunks'], 'column' | 'maxY' | 'minY'>>;
  registry: Pick<World['registry'], 'blockInfo'>;
}

/** The world model as a TerrainSource (layer 0, straight from the chunk store, no Vec3 allocation). */
export function worldSource(world: BlockStore): TerrainSource {
  const { chunks, registry } = world;
  const src: TerrainSource = {
    blockAt(x, y, z) {
      const s = chunks.stateIdAt(x, y, z);
      if (s === undefined) return undefined;
      return registry.blockInfo(s, s < 0 ? (chunks.runtimeIdAt(x, y, z) ?? 0) : 0);
    },
    get maxY() {
      return chunks.maxY;
    },
    get minY() {
      return chunks.minY;
    },
  };
  const column = chunks.column?.bind(chunks);
  if (column) {
    src.columnTop = (x, z) => {
      const col = column(x >> 4, z >> 4);
      if (!col?.loaded) return undefined;
      // sections at or above `count` are air; null sections are air; undefined = not received yet
      for (let rel = Math.min(col.count, col.sections.length) - 1; rel >= 0; rel--) {
        const sec = col.sections[rel];
        if (sec === undefined) return undefined;
        if (sec !== null) return (col.minCY + rel) * 16 + 15;
      }
      return col.minCY * 16 - 1;
    };
  }
  return src;
}

/** Classification at a position, undefined when not loaded. */
export function classAt(src: TerrainSource, x: number, y: number, z: number): TerrainClass | undefined {
  const b = src.blockAt(x, y, z);
  return b && classify(b);
}

const sameFenceFamily = (a: string, b: string): boolean => (a === 'nether_brick_fence') === (b === 'nether_brick_fence');

/** Does a fence / pane connect towards neighbour `n` lying along the x axis (`alongX`) or the z axis? */
function connectsTo(c: TerrainClass, n: TerrainClass | undefined, alongX: boolean): boolean {
  if (!n) return false;
  if (n.fullCube && !n.leaves) return true;
  if (c.connect === 'fence') {
    if (n.connect === 'fence') return sameFenceFamily(c.name, n.name);
    if (n.openable === 'gate') {
      // a gate spans x when it faces north / south: it connects to fences east and west of it
      const d = n.states['minecraft:cardinal_direction'];
      const dir = typeof d === 'string' ? d : 'south';
      return (dir === 'north' || dir === 'south') === alongX;
    }
    return false;
  }
  return n.connect === 'pane' || n.name.endsWith('_wall');
}

/**
 * The collision boxes the body meets at (x, y, z), with neighbour-dependent shapes: fence / pane /
 * bars arms towards connecting neighbours, and the upper half of a door shaped by its lower half.
 * undefined = not loaded.
 */
export function boxesAtCell(src: TerrainSource, x: number, y: number, z: number, c: TerrainClass | undefined = classAt(src, x, y, z)): readonly Box[] | undefined {
  if (!c) return undefined;
  if (c.connect) {
    let mask = 0;
    if (connectsTo(c, classAt(src, x, y, z - 1), false)) mask |= CONNECT_NORTH;
    if (connectsTo(c, classAt(src, x, y, z + 1), false)) mask |= CONNECT_SOUTH;
    if (connectsTo(c, classAt(src, x - 1, y, z), true)) mask |= CONNECT_WEST;
    if (connectsTo(c, classAt(src, x + 1, y, z), true)) mask |= CONNECT_EAST;
    return connectedBoxes(c.connect, mask);
  }
  if (c.doorUpper) {
    const lower = classAt(src, x, y - 1, z);
    if (lower?.openable === 'door' && !lower.doorUpper) return doorBoxes(c.states, lower.states);
  }
  return c.boxes;
}

/** The movement model's view of a TerrainSource: real collision shapes, friction and liquids. */
export function blockQueryOf(src: TerrainSource): BlockQuery {
  return {
    solidAt(x, y, z) {
      const c = classAt(src, x, y, z);
      return c && c.boxes.length > 0;
    },
    boxesAt(x, y, z) {
      return boxesAtCell(src, x, y, z);
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
