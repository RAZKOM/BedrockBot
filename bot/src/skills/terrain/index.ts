export { classify, LEAVES_PENALTY, SLOW_PENALTY } from './classify.ts';
export type { Liquid, Openable, TerrainClass } from './classify.ts';
export {
  boxesOf,
  boxesOfState,
  blockInfoOf,
  doorBoxes,
  connectedBoxes,
  connectKindOf,
  isDoorName,
  DOOR_THICKNESS,
  CONNECT_NORTH,
  CONNECT_SOUTH,
  CONNECT_WEST,
  CONNECT_EAST,
  SHAPES_DATA_VERSION,
} from './shapes.ts';
export type { ConnectKind } from './shapes.ts';
export { worldSource, classAt, blockQueryOf, boxesAtCell } from './query.ts';
export type { TerrainSource, BlockStore } from './query.ts';
