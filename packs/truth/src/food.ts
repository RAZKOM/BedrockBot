// Food-gathering commands (PLAN.md Phase 7 task 7.16, Track X, docs/food.md): read and fill a furnace
// or smoker, list the passive food mobs around a point with their baby flag, and build a fenced pen
// with a gate. Stable @minecraft/server 2.10.0 only. Registered by main.ts through `foodHandlers(deps)`.
//
//   furnace x y z                         -> {x, y, z, typeId, lit, size, slots: [{slot, typeId, amount} | null] x size}
//                                            (furnace / smoker / blast furnace: slot 0 input, 1 fuel, 2 output)
//   setfurnace x y z slot typeId|air [n]  -> the same after setting one slot
//   herd x y z r [tag]                    -> {mobs: [{entityId, typeId, baby, location, tags}]}: cows, pigs, sheep,
//                                            chickens, rabbits, mooshrooms within r (with `tag`: only those)
//   pen x y z w d                         -> {from, to, gate}: oak fence on the rim of x..x+w-1, z..z+d-1 at
//                                            height y (feet level), air inside, and a closed oak fence gate in
//                                            the middle of the north side (lowest z) that a player can open
import { BlockComponentTypes, BlockPermutation, ItemStack, type Block, type BlockInventoryComponent, type Dimension } from '@minecraft/server';
import { TruthError, blockPos, box, exactPos, int, nsId, num, type Box, type Vec3 } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface FoodDeps {
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
  overworld(): Dimension;
}

type FoodHandler = (args: string[]) => unknown;

export const FOOD_MOBS = ['minecraft:cow', 'minecraft:pig', 'minecraft:sheep', 'minecraft:chicken', 'minecraft:rabbit', 'minecraft:mooshroom'];

const vec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export function foodHandlers(deps: FoodDeps): Record<string, FoodHandler> {
  const { getBlock, assertLoaded, overworld } = deps;

  const furnaceAt = (p: Vec3) => {
    const dim = overworld();
    assertLoaded(dim, box(p, p));
    const b = getBlock(dim, p);
    const inv = b.getComponent(BlockComponentTypes.Inventory) as BlockInventoryComponent | undefined;
    const c = inv?.container;
    if (!c) throw new TruthError('no_container', `${b.typeId} at ${p.x} ${p.y} ${p.z} has no inventory`, { typeId: b.typeId });
    return { b, c };
  };

  const read = (p: Vec3) => {
    const { b, c } = furnaceAt(p);
    const slots: ({ slot: number; typeId: string; amount: number } | null)[] = [];
    for (let i = 0; i < c.size; i++) {
      const it = c.getItem(i);
      slots.push(it ? { slot: i, typeId: it.typeId, amount: it.amount } : null);
    }
    return { ...p, typeId: b.typeId, lit: b.typeId.includes('lit_'), size: c.size, slots };
  };

  return {
    furnace(args) {
      return read(blockPos(args, 0));
    },

    setfurnace(args) {
      const p = blockPos(args, 0);
      const slot = int(args[3], 'slot');
      const type = args[4];
      if (!type) throw new TruthError('bad_args', 'usage: setfurnace x y z slot typeId|air [n]');
      const { c } = furnaceAt(p);
      if (slot < 0 || slot >= c.size) throw new TruthError('bad_args', `slot must be 0..${c.size - 1}`);
      if (type === 'air') c.setItem(slot, undefined);
      else c.setItem(slot, new ItemStack(nsId(type), args[5] === undefined ? 1 : int(args[5], 'n')));
      return read(p);
    },

    herd(args) {
      const at = exactPos(args, 0);
      const r = num(args[3], 'r');
      const tag = args[4];
      const mobs = overworld()
        .getEntities({ location: at, maxDistance: r, excludeTypes: ['minecraft:player'], ...(tag ? { tags: [tag] } : {}) })
        .filter((e) => FOOD_MOBS.includes(e.typeId))
        .map((e) => ({ entityId: e.id, typeId: e.typeId, baby: e.getComponent('minecraft:is_baby') !== undefined, location: vec(e.location), tags: e.getTags() }));
      return { mobs };
    },

    pen(args) {
      const p = blockPos(args, 0);
      const w = int(args[3], 'w');
      const d = int(args[4], 'd');
      if (w < 3 || d < 3 || w > 32 || d > 32) throw new TruthError('bad_args', 'pen size must be 3..32 x 3..32');
      const to = { x: p.x + w - 1, y: p.y, z: p.z + d - 1 };
      const dim = overworld();
      assertLoaded(dim, box({ x: p.x, y: p.y - 1, z: p.z }, to));
      const fence = BlockPermutation.resolve('minecraft:oak_fence');
      const air = BlockPermutation.resolve('minecraft:air');
      const gate = { x: p.x + Math.floor(w / 2), y: p.y, z: p.z };
      for (let z = p.z; z <= to.z; z++) {
        for (let x = p.x; x <= to.x; x++) {
          const rim = x === p.x || x === to.x || z === p.z || z === to.z;
          getBlock(dim, { x, y: p.y, z }).setPermutation(rim ? fence : air);
        }
      }
      getBlock(dim, gate).setPermutation(BlockPermutation.resolve('minecraft:fence_gate', { 'minecraft:cardinal_direction': 'north', open_bit: false, in_wall_bit: false }));
      return { from: p, to, gate };
    },
  };
}
