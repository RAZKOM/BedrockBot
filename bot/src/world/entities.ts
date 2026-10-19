// Entity tracking (PLAN.md task 2.4): players, mobs and item drops by runtime id.
import type {
  AddEntity,
  AddItemEntity,
  AddPlayer,
  MoveEntity,
  MoveEntityDelta,
  MovePlayer,
  RemoveEntity,
  SetEntityMotion,
  TakeItemEntity,
} from './packets.ts';
import { toBigInt } from './packets.ts';
import type { EntityInfo, ItemStack } from './types.ts';

/** Bedrock sends entity rotations in move_entity_delta as one byte: degrees = byte * 360 / 256. */
export const byteToDegrees = (b: number): number => (b * 360) / 256;

// Pre-1.26.40 move_entity_delta flag bits (DeltaMoveFlags); newer versions use independent optionals.
const FLAG_HAS_X = 0x01;
const FLAG_HAS_Y = 0x02;
const FLAG_HAS_Z = 0x04;
const FLAG_HAS_ROT_X = 0x08;
const FLAG_HAS_ROT_Y = 0x10;
const FLAG_HAS_ROT_Z = 0x20;
const FLAG_ON_GROUND = 0x40;

function flagBits(flags: Record<string, boolean> | number): number {
  if (typeof flags === 'number') return flags;
  const names: [string, number][] = [
    ['has_x', FLAG_HAS_X],
    ['has_y', FLAG_HAS_Y],
    ['has_z', FLAG_HAS_Z],
    ['has_rot_x', FLAG_HAS_ROT_X],
    ['has_rot_y', FLAG_HAS_ROT_Y],
    ['has_rot_z', FLAG_HAS_ROT_Z],
    ['on_ground', FLAG_ON_GROUND],
  ];
  let bits = 0;
  for (const [n, b] of names) if (flags[n]) bits |= b;
  return bits;
}

export interface EntityTrackerOptions {
  /** Item stack for an item actor (needs the registry's item names). */
  toItem: (item: AddItemEntity['item']) => ItemStack;
  /** Our own runtime id: move_player for it is not an entity update. */
  selfRuntimeId: () => bigint;
  now?: () => number;
}

export class EntityTracker {
  readonly entities = new Map<bigint, EntityInfo>();
  private readonly byUniqueId = new Map<bigint, bigint>();
  private readonly opts: EntityTrackerOptions;
  private readonly now: () => number;
  private readonly addFns = new Set<(e: EntityInfo) => void>();
  private readonly removeFns = new Set<(e: EntityInfo) => void>();

  constructor(opts: EntityTrackerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => performance.now());
  }

  onAdd(fn: (e: EntityInfo) => void): () => void {
    this.addFns.add(fn);
    return () => this.addFns.delete(fn);
  }

  onRemove(fn: (e: EntityInfo) => void): () => void {
    this.removeFns.add(fn);
    return () => this.removeFns.delete(fn);
  }

  clear(): void {
    this.entities.clear();
    this.byUniqueId.clear();
  }

  private add(e: EntityInfo): void {
    const old = this.entities.get(e.runtimeId);
    if (old) this.byUniqueId.delete(old.uniqueId);
    this.entities.set(e.runtimeId, e);
    this.byUniqueId.set(e.uniqueId, e.runtimeId);
    for (const fn of [...this.addFns]) fn(e);
  }

  private remove(runtimeId: bigint): void {
    const e = this.entities.get(runtimeId);
    if (!e) return;
    this.entities.delete(runtimeId);
    this.byUniqueId.delete(e.uniqueId);
    for (const fn of [...this.removeFns]) fn(e);
  }

  handleAddPlayer(p: AddPlayer): void {
    this.add({
      runtimeId: toBigInt(p.runtime_id),
      uniqueId: toBigInt(p.unique_id),
      type: 'minecraft:player',
      username: p.username,
      pos: { ...p.position },
      vel: { ...p.velocity },
      yaw: p.yaw,
      pitch: p.pitch,
      headYaw: p.head_yaw,
      onGround: false,
      updatedAt: this.now(),
    });
  }

  handleAddEntity(p: AddEntity): void {
    this.add({
      runtimeId: toBigInt(p.runtime_id),
      uniqueId: toBigInt(p.unique_id),
      type: p.entity_type,
      pos: { ...p.position },
      vel: { ...p.velocity },
      yaw: p.yaw,
      pitch: p.pitch,
      headYaw: p.head_yaw,
      onGround: false,
      updatedAt: this.now(),
    });
  }

  handleAddItemEntity(p: AddItemEntity): void {
    this.add({
      runtimeId: toBigInt(p.runtime_entity_id),
      uniqueId: toBigInt(p.entity_id_self),
      type: 'minecraft:item',
      item: this.opts.toItem(p.item),
      pos: { ...p.position },
      vel: { ...p.velocity },
      yaw: 0,
      pitch: 0,
      headYaw: 0,
      onGround: false,
      updatedAt: this.now(),
    });
  }

  handleMoveEntityDelta(p: MoveEntityDelta): void {
    const e = this.entities.get(toBigInt(p.runtime_entity_id));
    if (!e) return;
    if (p.flags !== undefined) {
      // Legacy shape: a flag bitfield says which components are present.
      const bits = flagBits(p.flags);
      if (bits & FLAG_HAS_X && p.x !== undefined) e.pos.x = p.x;
      if (bits & FLAG_HAS_Y && p.y !== undefined) e.pos.y = p.y;
      if (bits & FLAG_HAS_Z && p.z !== undefined) e.pos.z = p.z;
      if (bits & FLAG_HAS_ROT_X && p.rot_x !== undefined) e.pitch = byteToDegrees(p.rot_x);
      if (bits & FLAG_HAS_ROT_Y && p.rot_y !== undefined) e.yaw = byteToDegrees(p.rot_y);
      if (bits & FLAG_HAS_ROT_Z && p.rot_z !== undefined) e.headYaw = byteToDegrees(p.rot_z);
      e.onGround = (bits & FLAG_ON_GROUND) !== 0;
    } else {
      // 1.26.40+: every component is an optional absolute value (floats; rotations as bytes).
      if (p.x !== undefined) e.pos.x = p.x;
      if (p.y !== undefined) e.pos.y = p.y;
      if (p.z !== undefined) e.pos.z = p.z;
      if (p.rot_x !== undefined) e.pitch = byteToDegrees(p.rot_x);
      if (p.rot_y !== undefined) e.yaw = byteToDegrees(p.rot_y);
      if (p.rot_z !== undefined) e.headYaw = byteToDegrees(p.rot_z);
      if (p.on_ground !== undefined) e.onGround = p.on_ground;
    }
    e.updatedAt = this.now();
  }

  handleMoveEntity(p: MoveEntity): void {
    const e = this.entities.get(toBigInt(p.runtime_entity_id));
    if (!e) return;
    e.pos = { ...p.position };
    if (p.rotation) {
      e.pitch = byteToDegrees(p.rotation.x);
      e.yaw = byteToDegrees(p.rotation.y);
      e.headYaw = byteToDegrees(p.rotation.z);
    }
    e.updatedAt = this.now();
  }

  handleMovePlayer(p: MovePlayer): void {
    const rid = toBigInt(p.runtime_id);
    if (rid === this.opts.selfRuntimeId()) return;
    const e = this.entities.get(rid);
    if (!e) return;
    e.pos = { ...p.position };
    e.yaw = p.yaw;
    e.pitch = p.pitch;
    e.headYaw = p.head_yaw;
    e.onGround = p.on_ground;
    e.updatedAt = this.now();
  }

  handleSetEntityMotion(p: SetEntityMotion): void {
    const e = this.entities.get(toBigInt(p.runtime_entity_id));
    if (!e) return;
    e.vel = { ...p.velocity };
    e.updatedAt = this.now();
  }

  handleRemoveEntity(p: RemoveEntity): void {
    const rid = this.byUniqueId.get(toBigInt(p.entity_id_self));
    if (rid !== undefined) this.remove(rid);
  }

  /** An item (or arrow) was picked up by `target`; the item actor is removed right after. */
  handleTakeItemEntity(p: TakeItemEntity): void {
    this.remove(toBigInt(p.runtime_entity_id));
  }
}
