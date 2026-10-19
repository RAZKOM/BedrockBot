// Block updates (PLAN.md task 2.3): `update_block`, `update_subchunk_blocks` and `block_entity_data`
// applied to the chunk store, with `onBlockUpdate` callbacks for layer 0.
import type { ChunkStore } from './chunks.ts';
import type { BlockEntityData, BlockUpdateEntry, UpdateBlock, UpdateSubchunkBlocks } from './packets.ts';
import type { BlockInfo, Vec3 } from './types.ts';
import nbt from 'prismarine-nbt';

export type BlockUpdateListener = (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void;

export class BlockUpdates {
  private readonly store: ChunkStore;
  private readonly listeners = new Set<BlockUpdateListener>();
  readonly stats = { updates: 0, ignored: 0, blockEntities: 0 };

  constructor(store: ChunkStore) {
    this.store = store;
  }

  onBlockUpdate(fn: BlockUpdateListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  handleUpdateBlock(p: UpdateBlock): void {
    this.apply(p.position, p.block_runtime_id, p.layer ?? 0);
  }

  handleUpdateSubchunkBlocks(p: UpdateSubchunkBlocks): void {
    for (const b of p.blocks) this.applyEntry(b, 0);
    for (const b of p.extra) this.applyEntry(b, 1);
  }

  handleBlockEntityData(p: BlockEntityData): void {
    const { x, y, z } = p.position;
    const col = this.store.column(x >> 4, z >> 4);
    if (!col) return;
    const data = nbt.simplify(p.nbt as unknown as nbt.NBT) as Record<string, unknown>;
    col.blockEntities.set(`${x},${y},${z}`, data);
    this.stats.blockEntities++;
  }

  /** Block entity (simplified NBT) at a position, if the column holds one. */
  blockEntityAt(p: Vec3): Record<string, unknown> | undefined {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    return this.store.column(x >> 4, z >> 4)?.blockEntities.get(`${x},${y},${z}`);
  }

  private applyEntry(b: BlockUpdateEntry, layer: number): void {
    this.apply(b.position, b.runtime_id, layer);
  }

  private apply(pos: Vec3, runtimeId: number, layer: number): void {
    const reg = this.store.registry;
    if (!reg.ready) {
      this.stats.ignored++;
      return;
    }
    const rid = runtimeId | 0;
    const stateId = reg.stateIdFromRuntimeId(rid);
    const { x, y, z } = pos;
    const { applied, before, beforeRuntimeId } = this.store.setStateId(x, y, z, stateId, rid, layer);
    if (!applied) {
      // Column or section not held yet: the pending subchunk answer will carry the new state.
      this.stats.ignored++;
      return;
    }
    this.stats.updates++;
    if (layer !== 0) return;
    const after = reg.blockInfo(stateId, rid);
    const beforeInfo = before === undefined ? undefined : reg.blockInfo(before, beforeRuntimeId ?? 0);
    if (beforeInfo && after.name !== beforeInfo.name) {
      // A replaced block takes its block entity with it (a new chest gets block_entity_data).
      this.store.column(x >> 4, z >> 4)?.blockEntities.delete(`${x},${y},${z}`);
    }
    for (const fn of [...this.listeners]) fn({ x, y, z }, beforeInfo, after);
  }
}
