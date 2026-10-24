// World-model types (PLAN.md section 4.2). Pure types, no runtime code.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Axis-aligned box in block-local coordinates, minecraft-data order: [minX, minY, minZ, maxX, maxY, maxZ]. */
export type Box = readonly [number, number, number, number, number, number];

export interface BlockInfo {
  /** Block name without namespace, minecraft-data style (`oak_log`). `unknown` for unresolved runtime ids. */
  name: string;
  /** Index into the registry's blockStates (minecraft-data state id). -1 when unknown. */
  stateId: number;
  /** Block states as plain values (`{ pillar_axis: 'y' }`); bytes stay numbers (0/1). */
  states: Readonly<Record<string, unknown>>;
  /** Mining hardness; -1 = unbreakable (bedrock), as minecraft-data reports it. */
  hardness: number;
  /** True when the block has at least one collision box. */
  solid: boolean;
  /** Collision boxes for this state (empty for air, flowers, water). */
  boxes: readonly Box[];
}

export interface EntityInfo {
  runtimeId: bigint;
  /** Unique (persistent) id; `remove_entity` refers to entities by this id. */
  uniqueId: bigint;
  /** `minecraft:player`, `minecraft:item`, `minecraft:cow`, ... */
  type: string;
  /** Player name for players. */
  username?: string;
  /** Item stack for item actors (`minecraft:item`). */
  item?: ItemStack;
  /** Position as the server sends it. For players this is the eye position (feet + 1.62). */
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  headYaw: number;
  onGround: boolean;
  /** Wall-clock ms of the last update (performance.now()). */
  updatedAt: number;
}

export interface ItemStack {
  /** Item name without namespace (`oak_log`); `unknown:<id>` if the registry does not know it. */
  name: string;
  /** Network (runtime) item id from `item_registry`. */
  networkId: number;
  count: number;
  metadata: number;
  stackId?: number;
  blockRuntimeId?: number;
  /** Track S: durability used up (the item NBT's `Damage`), when the item has one. */
  damage?: number;
}

export interface ContainerView {
  /** Numeric window id (0 inventory, 119 offhand, 120 armor, 124 ui, 1..99 open containers). */
  id: number;
  slots: readonly (ItemStack | null)[];
}

export interface SelfState {
  /** Feet position (eye - 1.62), as last reported by the server. */
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  yaw: number;
  pitch: number;
  health: number;
  food: number;
  gameMode: string;
  runtimeId: bigint;
  dimension: number;
}

export interface Correction {
  /** Feet position. */
  pos: Vec3;
  delta: Vec3;
  onGround: boolean;
  tick: bigint;
}

export interface FindOptions {
  origin: Vec3;
  /** Max Euclidean distance from origin (blocks). */
  radius: number;
  /** Stop after this many matches (closest first). */
  max: number;
  /**
   * Restrict the search to an indexed block class (fast path through the per-section index).
   * Without it every non-air block in range is visited.
   */
  class?: BlockClass;
}

/** Block classes with a per-section position index (PLAN.md task 2.6). */
export type BlockClass = 'log' | 'leaves' | 'chest';

/**
 * Minimal packet source the world model needs. `Connection` satisfies it; tests use a replay driver.
 * Handlers receive decoded packets exactly as bedrock-protocol produces them.
 */
export interface PacketSource {
  on(name: string, fn: (p: Record<string, unknown>) => void): () => void;
  queue(name: string, params: Record<string, unknown>): void;
  onTick?(fn: (tick: bigint) => void): () => void;
}

export interface WorldView {
  blockAt(p: Vec3): BlockInfo | undefined;
  isLoaded(cx: number, cz: number): boolean;
  find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: FindOptions): Vec3[];
  readonly entities: ReadonlyMap<bigint, EntityInfo>;
  readonly self: SelfState;
  readonly inventory: {
    readonly slots: readonly (ItemStack | null)[];
    readonly selected: number;
    window(id: number): ContainerView | undefined;
  };
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
  onCorrection(fn: (c: Correction) => void): () => void;
}
