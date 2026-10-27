// World facade (PLAN.md section 4.2): wires a packet source (Connection or a replay) to the registry
// shim, chunk store, block updates, entities, inventory and self state.
import { createLogger, type Logger } from '../log.ts';
import { boxChecksum } from './checksum.ts';
import { ChunkStore, type ChunkStoreOptions } from './chunks.ts';
import { EntityTracker } from './entities.ts';
import { BlockFinder } from './find.ts';
import { Inventory } from './inventory.ts';
import type * as P from './packets.ts';
import { toBigInt } from './packets.ts';
import { BlockRegistry } from './registry.ts';
import type {
  BlockInfo,
  ContainerView,
  Correction,
  EntityInfo,
  FindOptions,
  ItemStack,
  PacketSource,
  SelfState,
  Vec3,
  WorldView,
} from './types.ts';
import { BlockUpdates } from './updates.ts';
import type { CachedTerrain, FoundPos } from './cache/types.ts'; // Track T
import { DimensionWatcher } from './dimension.ts'; // Track AT

export const EYE_HEIGHT = 1.62;

export interface WorldOptions extends ChunkStoreOptions {
  /** Game version the connection speaks (selects the version shim). Default '1.26.60'. */
  version?: string;
  logger?: Logger;
}

const DIMENSIONS: Record<string, number> = { overworld: 0, nether: 1, the_end: 2, end: 2 };

function dimensionId(d: string | number): number {
  return typeof d === 'number' ? d : (DIMENSIONS[d] ?? 0);
}

function feet(eye: P.PVec3): Vec3 {
  return { x: eye.x, y: eye.y - EYE_HEIGHT, z: eye.z };
}

export class World implements WorldView {
  readonly registry: BlockRegistry;
  readonly chunks: ChunkStore;
  readonly updates: BlockUpdates;
  readonly entityTracker: EntityTracker;
  readonly inventory: Inventory;
  readonly finder: BlockFinder;
  /** Track T: the persistent world cache when one is attached (world/cache: `openWorldCache(world, ...)`). */
  cache: CachedTerrain | undefined;
  readonly self: SelfState = {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    onGround: false,
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    gameMode: 'unknown',
    runtimeId: 0n,
    dimension: 0,
  };
  private readonly log: Logger;
  private readonly source: PacketSource;
  private readonly unsubs: (() => void)[] = [];
  private readonly correctionFns = new Set<(c: Correction) => void>();

  constructor(source: PacketSource, opts: WorldOptions = {}) {
    this.source = source;
    this.log = opts.logger ?? createLogger('info', 'world');
    this.registry = new BlockRegistry({ version: opts.version, logger: this.log });
    this.chunks = new ChunkStore(this.registry, (name, params) => source.queue(name, params), { ...opts, logger: this.log });
    this.updates = new BlockUpdates(this.chunks);
    this.finder = new BlockFinder(this.chunks, this.registry);
    const toItem = (i: P.ItemV4) => this.itemStack(i);
    this.entityTracker = new EntityTracker({
      toItem: (i) => toItem(i) ?? { name: 'air', networkId: 0, count: 0, metadata: 0 },
      selfRuntimeId: () => this.self.runtimeId,
    });
    this.inventory = new Inventory(toItem, () => this.self.runtimeId);
    // Track AT: answers the server's dimension_change_ack (else BDS ignores the movement), reports changes; before subscribe() so 'start' sees the old dimension
    this.dimensions = new DimensionWatcher(source, { selfRuntimeId: () => this.self.runtimeId, dimension: () => this.self.dimension, loadedColumns: () => this.chunks.loadedCount, logger: this.log });
    this.subscribe();
  }

  /** Track AT: dimension changes (world/dimension.ts). */
  readonly dimensions: DimensionWatcher;

  get entities(): ReadonlyMap<bigint, EntityInfo> {
    return this.entityTracker.entities;
  }

  // ---- WorldView -----------------------------------------------------------------------------

  blockAt(p: Vec3): BlockInfo | undefined {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    const s = this.chunks.stateIdAt(x, y, z);
    if (s === undefined) return undefined;
    return this.registry.blockInfo(s, s < 0 ? (this.chunks.runtimeIdAt(x, y, z) ?? 0) : 0);
  }

  isLoaded(cx: number, cz: number): boolean {
    return this.chunks.isLoaded(cx, cz);
  }

  // Track T: positions from the world cache (unloaded columns) come back flagged `cached: true`; `cached: false` skips them.
  find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: FindOptions & { cached?: boolean }): FoundPos[] {
    return this.finder.find(pred, opts);
  }

  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void {
    return this.updates.onBlockUpdate(fn);
  }

  onCorrection(fn: (c: Correction) => void): () => void {
    this.correctionFns.add(fn);
    return () => this.correctionFns.delete(fn);
  }

  // ---- extras ----------------------------------------------------------------------------------

  /** Block entity NBT (simplified) at a position, e.g. a chest's Items. */
  blockEntityAt(p: Vec3): Record<string, unknown> | undefined {
    return this.updates.blockEntityAt(p);
  }

  /** truth:checksum-compatible FNV-1a over typeIds; undefined if any block in the box is not loaded. */
  checksum(a: Vec3, b: Vec3): string | undefined {
    return boxChecksum((p) => this.blockAt(p), a, b);
  }

  /** Window contents by numeric id (0 inventory, 119 offhand, 120 armor). */
  window(id: number): ContainerView | undefined {
    return this.inventory.window(id);
  }

  /**
   * Resolves once every column within `radius` chunks (Chebyshev) of `center` (block position;
   * default: own position) is loaded. Rejects after `timeoutMs`.
   */
  waitForChunks(radius: number, opts: { center?: Vec3; timeoutMs?: number } = {}): Promise<void> {
    const c = opts.center ?? this.self.pos;
    const ccx = Math.floor(c.x) >> 4;
    const ccz = Math.floor(c.z) >> 4;
    const missing = () => {
      let n = 0;
      for (let cx = ccx - radius; cx <= ccx + radius; cx++) for (let cz = ccz - radius; cz <= ccz + radius; cz++) if (!this.isLoaded(cx, cz)) n++;
      return n;
    };
    if (missing() === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out after ${opts.timeoutMs ?? 30_000} ms waiting for chunks (${missing()} of ${(2 * radius + 1) ** 2} columns missing)`));
      }, opts.timeoutMs ?? 30_000);
      const off = this.chunks.onColumnLoaded(() => {
        if (missing() === 0) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
  }

  /** Stop listening to the source. */
  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.dimensions.dispose(); // Track AT
  }

  // ---- wiring ----------------------------------------------------------------------------------

  private itemStack(i: P.ItemV4): ItemStack | null {
    if (!i || i.network_id === 0) return null;
    const stack: ItemStack = {
      name: this.registry.itemName(i.network_id) ?? `unknown:${i.network_id}`,
      networkId: i.network_id,
      count: i.count,
      metadata: i.metadata,
    };
    if (i.has_stack_id && i.stack_id !== undefined) stack.stackId = i.stack_id;
    if (i.block_runtime_id) stack.blockRuntimeId = i.block_runtime_id;
    const damage = (i as { extra?: { nbt?: { nbt?: { value?: { Damage?: { value?: unknown } } } } } }).extra?.nbt?.nbt?.value?.Damage?.value; // Track S: tool / armour wear
    if (typeof damage === 'number') stack.damage = damage;
    return stack;
  }

  private on<T>(name: string, fn: (p: T) => void): void {
    this.unsubs.push(
      this.source.on(name, (p) => {
        fn(p as unknown as T);
      }),
    );
  }

  private subscribe(): void {
    const { registry, chunks, updates, entityTracker: ents, inventory: inv, self } = this;

    this.on<P.StartGame>('start_game', (p) => {
      registry.handleStartGame(p);
      self.runtimeId = toBigInt(p.runtime_entity_id);
      self.pos = feet(p.player_position);
      if (p.rotation) {
        self.pitch = p.rotation.x;
        self.yaw = p.rotation.z;
      }
      // 'fallback' = the player has no own game mode; the world's applies.
      const mode = p.player_gamemode === 'fallback' ? p.world_gamemode : p.player_gamemode;
      if (mode !== undefined) self.gameMode = String(mode);
      self.dimension = dimensionId(p.dimension);
      chunks.clear(self.dimension);
      ents.clear();
      inv.clear();
    });
    this.on<P.ItemRegistry>('item_registry', (p) => {
      registry.handleItemRegistry(p);
    });
    this.on<{ status: string }>('play_status', (p) => {
      if (p.status === 'player_spawn') registry.finalize();
    });

    // Chunks and blocks.
    this.on<P.PublisherUpdate>('network_chunk_publisher_update', (p) => {
      chunks.handlePublisherUpdate(p);
    });
    this.on<P.LevelChunk>('level_chunk', (p) => {
      chunks.handleLevelChunk(p);
    });
    this.on<P.SubChunk>('subchunk', (p) => {
      chunks.handleSubChunk(p);
    });
    this.on<P.UpdateBlock>('update_block', (p) => {
      updates.handleUpdateBlock(p);
    });
    this.on<P.UpdateSubchunkBlocks>('update_subchunk_blocks', (p) => {
      updates.handleUpdateSubchunkBlocks(p);
    });
    this.on<P.BlockEntityData>('block_entity_data', (p) => {
      updates.handleBlockEntityData(p);
    });
    this.on<P.ChangeDimension>('change_dimension', (p) => {
      self.dimension = p.dimension;
      self.pos = { x: p.position.x, y: p.position.y, z: p.position.z }; // Track AT: feet (measured), approximate; the move_player after the ack is exact
      chunks.clear(p.dimension);
      ents.clear();
    });

    // Self.
    this.on<P.Respawn>('respawn', (p) => {
      if (p.state === 1) self.pos = feet(p.position);
    });
    this.on<P.MovePlayer>('move_player', (p) => {
      if (toBigInt(p.runtime_id) === self.runtimeId) {
        self.pos = feet(p.position);
        self.yaw = p.yaw;
        self.pitch = p.pitch;
        self.onGround = p.on_ground;
      } else {
        ents.handleMovePlayer(p);
      }
    });
    this.on<P.CorrectPrediction>('correct_player_move_prediction', (p) => {
      if (p.prediction_type !== undefined && p.prediction_type !== 'player') return;
      self.pos = feet(p.position);
      self.vel = { ...p.delta };
      self.onGround = p.on_ground;
      const c: Correction = { pos: { ...self.pos }, delta: { ...p.delta }, onGround: p.on_ground, tick: toBigInt(p.tick) };
      for (const fn of [...this.correctionFns]) fn(c);
    });
    this.on<P.SetHealth>('set_health', (p) => {
      self.health = p.health;
    });
    this.on<P.UpdateAttributes>('update_attributes', (p) => {
      if (toBigInt(p.runtime_entity_id) !== self.runtimeId) return;
      for (const a of p.attributes) {
        if (a.name === 'minecraft:health') self.health = a.current;
        else if (a.name === 'minecraft:player.hunger') self.food = a.current;
      }
    });
    this.on<P.SetPlayerGameType>('set_player_game_type', (p) => {
      self.gameMode = String(p.gamemode);
    });

    // Entities.
    this.on<P.AddPlayer>('add_player', (p) => {
      ents.handleAddPlayer(p);
    });
    this.on<P.AddEntity>('add_entity', (p) => {
      ents.handleAddEntity(p);
    });
    this.on<P.AddItemEntity>('add_item_entity', (p) => {
      ents.handleAddItemEntity(p);
    });
    this.on<P.MoveEntityDelta>('move_entity_delta', (p) => {
      ents.handleMoveEntityDelta(p);
    });
    this.on<P.MoveEntity>('move_entity', (p) => {
      ents.handleMoveEntity(p);
    });
    this.on<P.SetEntityMotion>('set_entity_motion', (p) => {
      if (toBigInt(p.runtime_entity_id) === self.runtimeId) self.vel = { ...p.velocity };
      else ents.handleSetEntityMotion(p);
    });
    this.on<P.RemoveEntity>('remove_entity', (p) => {
      ents.handleRemoveEntity(p);
    });
    this.on<P.TakeItemEntity>('take_item_entity', (p) => {
      ents.handleTakeItemEntity(p);
    });

    // Inventory.
    this.on<P.InventoryContent>('inventory_content', (p) => {
      inv.handleInventoryContent(p);
    });
    this.on<P.InventorySlot>('inventory_slot', (p) => {
      inv.handleInventorySlot(p);
    });
    this.on<P.InventoryTransaction>('inventory_transaction', (p) => {
      inv.handleInventoryTransaction(p);
    });
    this.on<P.PlayerHotbar>('player_hotbar', (p) => {
      inv.handlePlayerHotbar(p);
    });
    this.on<P.MobEquipment>('mob_equipment', (p) => {
      inv.handleMobEquipment(p);
    });

    // Request pump and retries.
    if (this.source.onTick) {
      this.unsubs.push(
        this.source.onTick(() => {
          chunks.pump();
        }),
      );
    }
  }
}

export { BlockRegistry, blockHash, fnv1a32 } from './registry.ts';
export { ChunkStore, Column } from './chunks.ts';
export { BlockUpdates } from './updates.ts';
export { EntityTracker } from './entities.ts';
export { Inventory, windowId, WINDOW_ARMOR, WINDOW_INVENTORY, WINDOW_OFFHAND } from './inventory.ts';
export { Hotbar, type HotbarOptions } from './hotbar.ts';
export { BlockFinder, classify } from './find.ts';
export { boxChecksum, typeIdOf } from './checksum.ts';
export { decodeSubChunk, Layer, Section, localIndex } from './subchunk.ts';
export { shimFor, SHIMS } from './version-shims/index.ts';
export { DimensionWatcher, dimensionName, dimensionIdOf } from './dimension.ts'; // Track AT
export type * from './types.ts';
