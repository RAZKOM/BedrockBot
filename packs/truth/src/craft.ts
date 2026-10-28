// Crafting e2e commands (wave 11, Track AW; docs/crafting.md "Truth commands"): give a whole kit in one
// request, read an inventory as plain counts, place or remove a crafting table. Stable
// @minecraft/server 2.10.0 only. Registered by main.ts through `craftHandlers(deps)`.
//
//   kit playerName [typeId:count ...]   -> {name, given: {typeId: count}}: clear the inventory (worn
//                                          armour too), then give each `typeId:count` (several stacks
//                                          when count > the stack size)
//   craftinv playerName                  -> {name, counts: {typeId: n}, stacks, free}: counts by item
//                                          without the namespace, stacks used, free slots
//   table x y z [remove]                 -> {x, y, z, typeId}: a crafting table at the block (or air)
import { EntityComponentTypes, EquipmentSlot, ItemStack, type Block, type Dimension, type EntityEquippableComponent, type EntityInventoryComponent, type Player, world } from '@minecraft/server';
import { TruthError, blockPos, box, nsId, type Box, type Vec3 } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface CraftDeps {
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
  overworld(): Dimension;
}

type CraftHandler = (args: string[]) => unknown;

function player(name: string | undefined): Player {
  if (!name) throw new TruthError('bad_args', 'missing playerName');
  const ps = world.getPlayers({ name });
  if (ps.length === 0) throw new TruthError('player_not_found', `no player ${name}`, { name });
  return ps[0]!;
}

function inventory(p: Player) {
  const c = (p.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined)?.container;
  if (!c) throw new TruthError('error', `player ${p.name} has no inventory container`);
  return c;
}

const ARMOR = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand];

export function craftHandlers(deps: CraftDeps): Record<string, CraftHandler> {
  const { getBlock, assertLoaded, overworld } = deps;
  return {
    kit(args) {
      const p = player(args[0]);
      const c = inventory(p);
      c.clearAll();
      const eq = p.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
      if (eq) for (const s of ARMOR) if (eq.getEquipment(s)) eq.setEquipment(s, undefined);
      const given: Record<string, number> = {};
      for (const spec of args.slice(1)) {
        const m = /^(.+):(\d+)$/.exec(spec);
        if (!m) throw new TruthError('bad_args', `kit items are typeId:count, got ${spec}`);
        const id = nsId(m[1]!);
        let left = Number(m[2]);
        const max = new ItemStack(id, 1).maxAmount;
        while (left > 0) {
          const n = Math.min(left, max);
          const rest = c.addItem(new ItemStack(id, n));
          const put = n - (rest?.amount ?? 0);
          given[id] = (given[id] ?? 0) + put;
          if (put < n) throw new TruthError('inventory_full', `${left - put} ${id} did not fit`, { given });
          left -= n;
        }
      }
      return { name: p.name, given };
    },

    craftinv(args) {
      const p = player(args[0]);
      const c = inventory(p);
      const counts: Record<string, number> = {};
      let stacks = 0;
      for (let i = 0; i < c.size; i++) {
        const it = c.getItem(i);
        if (!it) continue;
        stacks++;
        const n = it.typeId.replace(/^minecraft:/, '');
        counts[n] = (counts[n] ?? 0) + it.amount;
      }
      return { name: p.name, counts, stacks, free: c.size - stacks };
    },

    table(args) {
      const p = blockPos(args, 0);
      const dim = overworld();
      assertLoaded(dim, box(p, p));
      const b = getBlock(dim, p);
      b.setType(args[3] === 'remove' ? 'minecraft:air' : 'minecraft:crafting_table');
      return { ...p, typeId: b.typeId };
    },
  };
}
