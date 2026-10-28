// Elytra flight commands (wave 11, Track AU; docs/flight.md "Truth commands"): the server's own view
// of a player's glide (Entity.isGliding, isFalling, isOnGround, velocity), a per-tick trajectory log
// (the server's position and velocity every tick, so a flight model can be compared with the server
// without the strict-mode corrections), equipping an item straight into an equipment slot (the
// elytra into the chest slot), and a shulker box dropped as an item with contents (the fireworks box
// of the flight kit: the Script API cannot write a box item's NBT, so the box is placed as a block,
// filled, and broken with `setblock ... destroy`, which drops it with its contents). Stable
// @minecraft/server 2.10.0 only. Registered by main.ts through `flyHandlers()`.
//
//   glide playerName                              -> {name, isGliding, isFalling, isOnGround, isFlying,
//                                                     isSprinting, location, velocity, rotation, health, tick}
//   glidelog start playerName | stop | read [sinceTick]  -> start: {name}; read: {now, entries: [{tick, x, y, z,
//                                                     vx, vy, vz, gliding, ground}]} (at most 4000 ticks kept)
//   equip playerName Head|Chest|Legs|Feet|Offhand typeId|air [amount] [damage] -> {name, slot, typeId}
//   boxdrop x y z typeId amount [stacks]          -> {at, typeId, stacks}: an undyed shulker box with
//                                                     `stacks` stacks of `amount` items, dropped at x y z
//                                                     as an item entity (pick it up by walking over it)
import {
  BlockComponentTypes,
  EntityComponentTypes,
  EquipmentSlot,
  ItemComponentTypes,
  ItemStack,
  Player,
  system,
  world,
  type BlockInventoryComponent,
  type EntityEquippableComponent,
  type EntityHealthComponent,
  type ItemDurabilityComponent,
} from '@minecraft/server';
import { TruthError, blockPos, int, nsId, type Vec3 } from './protocol.js';

type FlyHandler = (args: string[]) => unknown;

const LOG_SIZE = 4000;

interface GlideEntry {
  tick: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gliding: boolean;
  ground: boolean;
}

const glideLog: GlideEntry[] = [];
let logName: string | undefined;
let logHandle: number | undefined;

function player(name: string | undefined): Player {
  if (!name) throw new TruthError('bad_args', 'missing playerName');
  const ps = world.getPlayers({ name });
  if (ps.length === 0) throw new TruthError('player_not_found', `no player ${name}`, { name });
  return ps[0]!;
}

const SLOTS: Record<string, EquipmentSlot> = {
  head: EquipmentSlot.Head,
  chest: EquipmentSlot.Chest,
  legs: EquipmentSlot.Legs,
  feet: EquipmentSlot.Feet,
  offhand: EquipmentSlot.Offhand,
};

function glideState(p: Player) {
  const rot = p.getRotation();
  const v = p.getVelocity();
  const l = p.location;
  const health = p.getComponent(EntityComponentTypes.Health) as EntityHealthComponent | undefined;
  return {
    name: p.name,
    isGliding: p.isGliding,
    isFalling: p.isFalling,
    isOnGround: p.isOnGround,
    isFlying: p.isFlying,
    isSprinting: p.isSprinting,
    location: { x: l.x, y: l.y, z: l.z },
    velocity: { x: v.x, y: v.y, z: v.z },
    rotation: { pitch: rot.x, yaw: rot.y },
    health: health?.currentValue ?? null,
    tick: system.currentTick,
  };
}

function sample(): void {
  if (!logName) return;
  try {
    const p = world.getPlayers({ name: logName })[0];
    if (!p) return;
    const l = p.location;
    const v = p.getVelocity();
    glideLog.push({ tick: system.currentTick, x: l.x, y: l.y, z: l.z, vx: v.x, vy: v.y, vz: v.z, gliding: p.isGliding, ground: p.isOnGround });
    if (glideLog.length > LOG_SIZE) glideLog.splice(0, glideLog.length - LOG_SIZE);
  } catch {
    // the player may be leaving
  }
}

export function flyHandlers(): Record<string, FlyHandler> {
  return {
    glide(args) {
      return glideState(player(args[0]));
    },

    glidelog(args) {
      const sub = (args[0] ?? 'read').toLowerCase();
      if (sub === 'start') {
        const p = player(args[1]);
        logName = p.name;
        glideLog.length = 0;
        if (logHandle === undefined) logHandle = system.runInterval(sample, 1);
        return { name: p.name, tick: system.currentTick };
      }
      if (sub === 'stop') {
        logName = undefined;
        if (logHandle !== undefined) system.clearRun(logHandle);
        logHandle = undefined;
        return { stopped: true, entries: glideLog.length };
      }
      const since = args[1] === undefined ? 0 : int(args[1], 'sinceTick');
      return { now: system.currentTick, name: logName ?? null, entries: glideLog.filter((e) => e.tick >= since) };
    },

    equip(args) {
      const p = player(args[0]);
      const slot = SLOTS[(args[1] ?? '').toLowerCase()];
      if (!slot || !args[2]) throw new TruthError('bad_args', 'usage: equip playerName Head|Chest|Legs|Feet|Offhand typeId|air [amount] [damage]');
      const eq = p.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
      if (!eq) throw new TruthError('error', `player ${p.name} is not equippable`);
      if (args[2] === 'air' || args[2] === 'minecraft:air') {
        eq.setEquipment(slot, undefined);
        return { name: p.name, slot: args[1], typeId: null };
      }
      let st: ItemStack;
      try {
        st = new ItemStack(nsId(args[2]), args[3] === undefined ? 1 : int(args[3], 'amount'));
      } catch (e) {
        throw new TruthError('unknown_item', `cannot make ${args[2]}: ${String(e)}`, { typeId: args[2] });
      }
      if (args[4] !== undefined) {
        const d = st.getComponent(ItemComponentTypes.Durability) as ItemDurabilityComponent | undefined;
        if (!d) throw new TruthError('no_durability', `${args[2]} has no durability`);
        d.damage = Math.max(0, Math.min(int(args[4], 'damage'), d.maxDurability));
      }
      eq.setEquipment(slot, st);
      return { name: p.name, slot: args[1], typeId: st.typeId, amount: st.amount };
    },

    boxdrop(args) {
      const at: Vec3 = blockPos(args, 0);
      const typeId = args[3];
      if (!typeId || args[4] === undefined) throw new TruthError('bad_args', 'usage: boxdrop x y z typeId amount [stacks]');
      const amount = int(args[4], 'amount');
      const stacks = args[5] === undefined ? 1 : int(args[5], 'stacks');
      const dim = world.getDimension('overworld');
      const b = dim.getBlock(at);
      if (!b) throw new TruthError('unloaded_chunk', `unloaded_chunk at ${at.x} ${at.y} ${at.z}`, { at });
      const id = nsId(typeId);
      b.setType('minecraft:undyed_shulker_box');
      // the block entity's inventory is not readable in the tick the block is set ("Failed to get property 'size'"):
      // fill and break it a tick later; `destroy` drops the box as an item with its contents (the Script API
      // cannot write a box item's NBT)
      system.runTimeout(() => {
        try {
          const c = (dim.getBlock(at)?.getComponent(BlockComponentTypes.Inventory) as BlockInventoryComponent | undefined)?.container;
          if (c) for (let i = 0; i < Math.min(stacks, c.size); i++) c.setItem(i, new ItemStack(id, amount));
        } finally {
          dim.runCommand(`setblock ${at.x} ${at.y} ${at.z} air [] destroy`);
        }
      }, 1);
      return { at, typeId: id, stacks, amount, scheduled: true };
    },
  };
}
