// Shapes of the inbound packets the world model consumes, as bedrock-protocol 3.60.1 decodes them for
// minecraft-data bedrock 1.26.51. Only the fields used here are typed. The Connection layer's
// InboundPackets does not cover most of these yet (see docs/world-model.md, "Connection API gaps").

export interface PVec3 {
  x: number;
  y: number;
  z: number;
}

/** varint64 / zigzag64 fields: bigint when decoded live, string in jsonl params. */
export type Long = bigint | number | string;

export interface NbtTag {
  type: string;
  name?: string;
  value: unknown;
}

export interface StartGame {
  runtime_entity_id: Long;
  player_gamemode?: string | number;
  world_gamemode?: string | number;
  player_position: PVec3;
  rotation?: { x: number; z: number };
  dimension: string | number;
  block_network_ids_are_hashes?: boolean;
  itemstates?: ItemStateEntry[];
  [k: string]: unknown;
}

export interface ItemStateEntry {
  name: string;
  runtime_id: number;
  component_based: boolean;
  version?: unknown;
  nbt?: unknown;
}

export interface ItemRegistry {
  itemstates: ItemStateEntry[];
}

export interface LevelChunk {
  x: number;
  z: number;
  dimension: number;
  sub_chunk_count: number;
  highest_subchunk_count?: number;
  cache_enabled: boolean;
  payload: Uint8Array;
}

export type SubChunkResult =
  | 'undefined'
  | 'success'
  | 'chunk_not_found'
  | 'invalid_dimension'
  | 'player_not_found'
  | 'y_index_out_of_bounds'
  | 'success_all_air';

export interface SubChunkEntry {
  dx: number;
  dy: number;
  dz: number;
  result: SubChunkResult;
  payload?: Uint8Array;
}

export interface SubChunk {
  cache_enabled: boolean;
  dimension: number;
  origin: PVec3;
  entries: SubChunkEntry[];
}

export interface PublisherUpdate {
  coordinates: PVec3;
  /** In blocks. */
  radius: number;
}

export interface UpdateBlock {
  position: PVec3;
  block_runtime_id: number;
  layer: number;
}

export interface BlockUpdateEntry {
  position: PVec3;
  runtime_id: number;
}

export interface UpdateSubchunkBlocks {
  x: number;
  y: number;
  z: number;
  blocks: BlockUpdateEntry[];
  extra: BlockUpdateEntry[];
}

export interface BlockEntityData {
  position: PVec3;
  nbt: NbtTag;
}

export interface ChangeDimension {
  dimension: number;
  position: PVec3;
}

export interface ItemV4 {
  network_id: number;
  count: number;
  metadata: number;
  has_stack_id?: boolean;
  stack_id?: number;
  block_runtime_id?: number;
}

export interface AddPlayer {
  uuid: string;
  username: string;
  runtime_id: Long;
  position: PVec3;
  velocity: PVec3;
  pitch: number;
  yaw: number;
  head_yaw: number;
  unique_id: Long;
}

export interface AddEntity {
  unique_id: Long;
  runtime_id: Long;
  entity_type: string;
  position: PVec3;
  velocity: PVec3;
  pitch: number;
  yaw: number;
  head_yaw: number;
}

export interface AddItemEntity {
  entity_id_self: Long;
  runtime_entity_id: Long;
  item: ItemV4;
  position: PVec3;
  velocity: PVec3;
}

/**
 * 1.26.40+: every component is an independent optional. Older versions carried a `flags` bitfield
 * (has_x, has_y, has_z, has_rot_x, has_rot_y, has_rot_z, on_ground, teleport, force_move); the
 * handler accepts both shapes.
 */
export interface MoveEntityDelta {
  runtime_entity_id: Long;
  flags?: Record<string, boolean> | number;
  x?: number;
  y?: number;
  z?: number;
  rot_x?: number;
  rot_y?: number;
  rot_z?: number;
  on_ground?: boolean;
}

export interface MoveEntity {
  runtime_entity_id: Long;
  flags?: unknown;
  position: PVec3;
  rotation?: { x: number; y: number; z: number };
}

export interface SetEntityMotion {
  runtime_entity_id: Long;
  velocity: PVec3;
}

export interface RemoveEntity {
  entity_id_self: Long;
}

export interface TakeItemEntity {
  runtime_entity_id: Long;
  target: Long;
}

export interface MovePlayer {
  runtime_id: Long;
  position: PVec3;
  pitch: number;
  yaw: number;
  head_yaw: number;
  mode: string;
  on_ground: boolean;
  tick?: Long;
}

export interface CorrectPrediction {
  prediction_type?: string;
  position: PVec3;
  delta: PVec3;
  on_ground: boolean;
  tick: Long;
}

export interface Respawn {
  position: PVec3;
  state: number;
  runtime_entity_id: Long;
}

export interface SetHealth {
  health: number;
}

export interface UpdateAttributes {
  runtime_entity_id: Long;
  attributes: { name: string; current: number }[];
}

export interface SetPlayerGameType {
  gamemode: string | number;
}

export type WindowIdField = string | number;

export interface InventoryContent {
  window_id: WindowIdField;
  input: ItemV4[];
}

export interface InventorySlot {
  window_id: WindowIdField;
  slot: number;
  item: ItemV4;
}

/** Clientbound inventory_transaction: BDS announces server-side changes (e.g. /give) as 'normal' actions. */
export interface InventoryTransaction {
  transaction: {
    transaction_type: string;
    actions?: { source_type: string; window_id?: WindowIdField; slot: number; old_item: ItemV4; new_item: ItemV4 }[];
  };
}

export interface PlayerHotbar {
  selected_slot: number;
  window_id: WindowIdField;
  select_slot: boolean;
}

export interface MobEquipment {
  runtime_entity_id: Long;
  item: ItemV4;
  slot: number;
  selected_slot: number;
  window_id: WindowIdField;
}

export function toBigInt(v: Long | undefined): bigint {
  if (v === undefined) return 0n;
  return typeof v === 'bigint' ? v : BigInt(v);
}
