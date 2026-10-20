// Connection-layer types (PLAN.md section 4.1). Packet shapes follow minecraft-data bedrock 1.26.51
// as decoded by bedrock-protocol 3.60.1. Only the fields the bot uses are typed; everything else is
// still present at runtime. Any packet name can be used through the untyped overloads.

export type Transport = 'raknet' | 'nethernet';

/**
 * How a NetherNet client finds the server and exchanges WebRTC offers: 'lan' = LAN discovery on
 * UDP 7551 (local BDS, offline), 'services' = the Minecraft services signalling WebSocket (Realms;
 * needs a signed-in account).
 */
export type NethernetSignalling = 'lan' | 'services';

/** A local BDS in offline mode (online-mode=false). */
export interface BdsTarget {
  kind: 'bds';
  host: string;
  /** RakNet port. NetherNet with LAN signalling ignores it (discovery is on UDP 7551). */
  port: number;
  transport: Transport;
  offline: true;
  /** Chunk radius to request; overrides ConnectionOptions.viewDistance. */
  viewDistance?: number;
}

/**
 * A Realm (PLAN.md task 1.6). Realms are NetherNet-only with services signalling. Sign-in is done by
 * the human through the device-code flow, never by code; the token cache lives in profilesFolder,
 * which must be outside the repository. Exactly one of realmName, realmInvite, realmId.
 */
export interface RealmTarget {
  kind: 'realm';
  /** Realm name as shown in the Realms list (exact match, else a unique case-insensitive match). */
  realmName?: string;
  /** Invite code or link. */
  realmInvite?: string;
  realmId?: string;
  /** Token cache key for prismarine-auth (a local label, e.g. 'bot'); the in-game name is the account's gamertag. */
  accountName: string;
  /** Token cache directory (absolute, outside the repo). */
  profilesFolder: string;
  /** Chunk radius to request; overrides ConnectionOptions.viewDistance. */
  viewDistance?: number;
}

export type ConnectTarget = BdsTarget | RealmTarget;

export type ConnectionState = 'idle' | 'connecting' | 'spawned' | 'closed';

export interface Vec3 { x: number; y: number; z: number }
export interface Vec2 { x: number; z: number }

/** Any decoded packet. Fields are whatever minecraft-data defines for the packet. */
export type AnyPacket = Record<string, unknown>;

export type TextType =
  | 'raw' | 'chat' | 'translation' | 'popup' | 'jukebox_popup' | 'tip' | 'system'
  | 'whisper' | 'announcement' | 'json_whisper' | 'json' | 'json_announcement';

export interface TextPacket {
  needs_translation: boolean;
  category?: 'message_only' | 'authored' | 'parameters';
  type: TextType;
  source_name?: string;
  message: string;
  parameters?: string[];
  xuid?: string;
  platform_chat_id?: string;
  /** Outbound: false (or omit) unless filtered_message is set. */
  has_filtered_message?: boolean;
  filtered_message?: string;
}

export interface StartGamePacket {
  entity_id: bigint;
  runtime_entity_id: bigint;
  /** Placeholder (y = 32769) on BDS 1.26; the real spawn arrives in `respawn` state 1. */
  player_position: Vec3;
  dimension: string | number;
  block_network_ids_are_hashes?: boolean;
  game_version?: string;
  [k: string]: unknown;
}

export interface RespawnPacket {
  /** Eye position (feet + 1.62). */
  position: Vec3;
  /** 0 searching for spawn, 1 server ready, 2 client ready. */
  state: number;
  runtime_entity_id: bigint;
}

export type PlayStatus =
  | 'login_success' | 'failed_client' | 'failed_spawn' | 'player_spawn' | 'failed_invalid_tenant'
  | 'failed_vanilla_edu' | 'failed_edu_vanilla' | 'failed_server_full'
  | 'failed_editor_vanilla_mismatch' | 'failed_vanilla_editor_mismatch';

export interface PlayStatusPacket { status: PlayStatus }

export interface MovePlayerPacket {
  runtime_id: number;
  /** Eye position. */
  position: Vec3;
  pitch: number;
  yaw: number;
  head_yaw: number;
  mode: 'normal' | 'reset' | 'teleport' | 'rotation';
  on_ground: boolean;
  ridden_runtime_id: number;
  tick: bigint;
}

export interface CorrectPlayerMovePredictionPacket {
  prediction_type: 'player' | 'vehicle';
  /** Eye position. */
  position: Vec3;
  delta: Vec3;
  rotation: { x: number; y: number };
  angular_velocity?: number;
  on_ground: boolean;
  tick: bigint;
}

export interface PlayerAuthInputPacket {
  pitch: number;
  yaw: number;
  /** Eye position (feet + 1.62). */
  position: Vec3;
  move_vector: Vec2;
  head_yaw: number;
  input_data: string[];
  input_mode: string;
  play_mode: string;
  interaction_model: string;
  interact_rotation: Vec2;
  tick: bigint;
  delta: Vec3;
  analogue_move_vector: Vec2;
  camera_orientation: Vec3;
  raw_move_vector: Vec2;
  [k: string]: unknown;
}

export interface LevelChunkPacket {
  x: number;
  z: number;
  dimension: number;
  sub_chunk_count: number;
  highest_subchunk_count?: number;
  cache_enabled: boolean;
  blobs?: bigint[];
  payload: Uint8Array;
}

export interface SubChunkEntry {
  dx: number;
  dy: number;
  dz: number;
  result: string;
  payload?: Uint8Array;
  [k: string]: unknown;
}

export interface SubChunkPacket {
  cache_enabled: boolean;
  dimension: number;
  origin: { x: number; y: number; z: number };
  entries: SubChunkEntry[];
}

export interface SubChunkRequestPacket {
  dimension: number;
  origin: { x: number; y: number; z: number };
  requests: { x: number; y: number; z: number }[];
}

export interface UpdateBlockPacket {
  position: { x: number; y: number; z: number };
  block_runtime_id: number;
  flags: unknown;
  layer: number;
}

export interface AddPlayerPacket {
  uuid: string;
  username: string;
  runtime_id: bigint;
  position: Vec3;
  [k: string]: unknown;
}

export interface DisconnectPacket {
  reason: string;
  hide_disconnect_reason: boolean;
  message?: string;
  filtered_message?: string;
}

export interface ServerboundLoadingScreenPacket {
  /** 1 = start of loading screen, 2 = end. */
  type: number;
  loading_screen_id?: number;
}

/** Knockback, explosions, /damage pushes. `tick` = the input tick the server applied it after (0 when not tied to an input). */
export interface SetEntityMotionPacket {
  runtime_entity_id: bigint | number;
  velocity: Vec3;
  tick?: bigint | number;
}

export interface SetHealthPacket {
  health: number;
}

export interface UpdateAttributesPacket {
  runtime_entity_id: bigint | number;
  attributes: {
    min: number;
    max: number;
    current: number;
    default_min: number;
    default_max: number;
    default: number;
    name: string;
    modifiers: unknown[];
  }[];
  tick?: bigint | number;
}

export interface InboundPackets {
  text: TextPacket;
  set_entity_motion: SetEntityMotionPacket;
  set_health: SetHealthPacket;
  update_attributes: UpdateAttributesPacket;
  start_game: StartGamePacket;
  respawn: RespawnPacket;
  play_status: PlayStatusPacket;
  move_player: MovePlayerPacket;
  correct_player_move_prediction: CorrectPlayerMovePredictionPacket;
  level_chunk: LevelChunkPacket;
  subchunk: SubChunkPacket;
  update_block: UpdateBlockPacket;
  add_player: AddPlayerPacket;
  disconnect: DisconnectPacket;
}

export interface OutboundPackets {
  text: TextPacket;
  respawn: RespawnPacket;
  player_auth_input: PlayerAuthInputPacket;
  subchunk_request: SubChunkRequestPacket;
  serverbound_loading_screen: ServerboundLoadingScreenPacket;
  move_player: MovePlayerPacket;
}

/**
 * What ended a session: a server `disconnect` packet (kick), a transport error, no spawn in time,
 * a failed ping, the version gate, our own disconnect(), or a plain close without any packet.
 */
export type CloseKind = 'kick' | 'error' | 'timeout' | 'ping' | 'version' | 'client' | 'closed';

/** Why a session ended, as far as the client can tell. */
export interface CloseInfo {
  /** Disconnect packet reason / message, transport error, or 'client' when we closed it. */
  reason: string;
  /** Category of `reason`. */
  kind: CloseKind;
  /** The server's disconnect packet, when it sent one: `reason` is the DisconnectFailReason name. */
  kick?: { reason: string; message?: string };
  /** The server or the version gate refused our game version; never retried. */
  versionMismatch?: boolean;
  /** How long the session had been spawned (ms); 0 when it never spawned. */
  spawnedMs?: number;
  /** True when the reconnect policy will try again. */
  willReconnect: boolean;
  /** Delay before the next attempt (ms), when willReconnect. */
  retryInMs?: number;
}
