// Home logistics commands (wave 9, Track AG; docs/home.md "Truth commands"): fill a container block
// with items in one request (the e2e builds a home of chests holding coal, logs, empty shulker boxes,
// and fills chests to the brim). Reading a container is truth:container (wood.ts). Stable
// @minecraft/server 2.10.0 only. Registered by main.ts through `homeHandlers(deps)`.
//
//   chestput x y z typeId amount [stacks|all]   -> {typeId, size, slots, free}: `stacks` (default 1)
//                                                  stacks of `amount` items each into the first free
//                                                  slots of the block's inventory (`all`: every free slot)
//   namebox x y z slot|boxes name               Track AV: give the item in that slot of the container (or
//                                                  every shulker box in it: `boxes`) the custom name `name`
//                                                  (ItemStack.nameTag; the item keeps its other data, a box
//                                                  its contents) -> {typeId, named: [{slot, typeId}]}
//   nameinv playerName slot|boxes name           Track AV: the same in a player's inventory
//   boxmix x y z typeId amount stacks [typeId amount stacks]...
//                                                Track AV: an undyed shulker box dropped as an item at x y z
//                                                holding the given stacks in that order (like fly.ts boxdrop,
//                                                with mixed contents: the Script API cannot write a box item's
//                                                NBT, so the box is placed, filled a tick later and destroyed)
import { BlockComponentTypes, EntityComponentTypes, ItemStack, system, world, type Block, type BlockInventoryComponent, type Container, type Dimension, type EntityInventoryComponent } from '@minecraft/server';
import { TruthError, blockPos, box, int, nsId, type Box, type Vec3 } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface HomeDeps {
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
  overworld(): Dimension;
}

type HomeHandler = (args: string[]) => unknown;

/** Track AV: name the item in `which` (a slot number, or `boxes`: every shulker box) of a container. */
function nameItems(c: Container, which: string | undefined, name: string | undefined): { slot: number; typeId: string }[] {
  if (which === undefined || !name) throw new TruthError('bad_args', 'usage: ... slot|boxes name');
  const slots = which === 'boxes' ? [...Array(c.size).keys()] : [int(which, 'slot')];
  const named: { slot: number; typeId: string }[] = [];
  for (const i of slots) {
    const it = c.getItem(i);
    if (!it) continue;
    if (which === 'boxes' && !it.typeId.endsWith('shulker_box')) continue;
    it.nameTag = name;
    c.setItem(i, it);
    named.push({ slot: i, typeId: it.typeId });
  }
  if (named.length === 0) throw new TruthError('nothing_named', `no item to name in ${which}`);
  return named;
}

export function homeHandlers(deps: HomeDeps): Record<string, HomeHandler> {
  const { getBlock, assertLoaded, overworld } = deps;
  return {
    chestput(args) {
      const p = blockPos(args, 0);
      const typeId = args[3];
      if (!typeId || args[4] === undefined) throw new TruthError('bad_args', 'usage: chestput x y z typeId amount [stacks|all]');
      const amount = int(args[4], 'amount');
      const all = args[5] === 'all';
      const want = all ? Infinity : args[5] === undefined ? 1 : int(args[5], 'stacks');
      const dim = overworld();
      assertLoaded(dim, box(p, p));
      const b = getBlock(dim, p);
      const c = (b.getComponent(BlockComponentTypes.Inventory) as BlockInventoryComponent | undefined)?.container;
      if (!c) throw new TruthError('no_container', `${b.typeId} at ${p.x} ${p.y} ${p.z} has no inventory`, { typeId: b.typeId });
      const id = nsId(typeId);
      const slots: number[] = [];
      for (let i = 0; i < c.size && slots.length < want; i++) {
        if (c.getItem(i)) continue;
        c.setItem(i, new ItemStack(id, amount));
        slots.push(i);
      }
      if (!all && slots.length < want) throw new TruthError('container_full', `only ${slots.length} of ${want} stacks fit`, { slots });
      let free = 0;
      for (let i = 0; i < c.size; i++) if (!c.getItem(i)) free++;
      return { typeId: id, size: c.size, slots, free };
    },

    namebox(args) {
      const p = blockPos(args, 0);
      const dim = overworld();
      assertLoaded(dim, box(p, p));
      const b = getBlock(dim, p);
      const c = (b.getComponent(BlockComponentTypes.Inventory) as BlockInventoryComponent | undefined)?.container;
      if (!c) throw new TruthError('no_container', `${b.typeId} at ${p.x} ${p.y} ${p.z} has no inventory`, { typeId: b.typeId });
      return { typeId: b.typeId, named: nameItems(c, args[3], args.slice(4).join(' ')) };
    },

    boxmix(args) {
      const at = blockPos(args, 0);
      const specs: { id: string; amount: number; stacks: number }[] = [];
      for (let i = 3; i + 2 < args.length; i += 3) specs.push({ id: nsId(args[i]!), amount: int(args[i + 1], 'amount'), stacks: int(args[i + 2], 'stacks') });
      if (specs.length === 0) throw new TruthError('bad_args', 'usage: boxmix x y z typeId amount stacks [typeId amount stacks]...');
      const dim = overworld();
      const b = dim.getBlock(at);
      if (!b) throw new TruthError('unloaded_chunk', `unloaded_chunk at ${at.x} ${at.y} ${at.z}`, { at });
      b.setType('minecraft:undyed_shulker_box');
      system.runTimeout(() => {
        try {
          const c = (dim.getBlock(at)?.getComponent(BlockComponentTypes.Inventory) as BlockInventoryComponent | undefined)?.container;
          let slot = 0;
          if (c) for (const sp of specs) for (let k = 0; k < sp.stacks && slot < c.size; k++) c.setItem(slot++, new ItemStack(sp.id, sp.amount));
        } finally {
          dim.runCommand(`setblock ${at.x} ${at.y} ${at.z} air [] destroy`);
        }
      }, 1);
      return { at, specs, scheduled: true };
    },

    nameinv(args) {
      const who = args[0];
      if (!who) throw new TruthError('bad_args', 'usage: nameinv playerName slot|boxes name');
      const p = world.getPlayers({ name: who })[0];
      if (!p) throw new TruthError('player_not_found', `no player ${who}`, { name: who });
      const c = (p.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined)?.container;
      if (!c) throw new TruthError('error', `player ${who} has no inventory container`);
      return { name: who, named: nameItems(c, args[1], args.slice(2).join(' ')) };
    },
  };
}
