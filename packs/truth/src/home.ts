// Home logistics commands (wave 9, Track AG; docs/home.md "Truth commands"): fill a container block
// with items in one request (the e2e builds a home of chests holding coal, logs, empty shulker boxes,
// and fills chests to the brim). Reading a container is truth:container (wood.ts). Stable
// @minecraft/server 2.10.0 only. Registered by main.ts through `homeHandlers(deps)`.
//
//   chestput x y z typeId amount [stacks|all]   -> {typeId, size, slots, free}: `stacks` (default 1)
//                                                  stacks of `amount` items each into the first free
//                                                  slots of the block's inventory (`all`: every free slot)
import { BlockComponentTypes, ItemStack, type Block, type BlockInventoryComponent, type Dimension } from '@minecraft/server';
import { TruthError, blockPos, box, int, nsId, type Box, type Vec3 } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface HomeDeps {
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
  overworld(): Dimension;
}

type HomeHandler = (args: string[]) => unknown;

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
  };
}
