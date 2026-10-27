// `!get` and stash commands (wave 8, Track AD; docs/get.md "Truth commands"): fill an inventory with
// full stacks in one request, and read item contents nested in shulker box items, in the player's
// inventory and in item entities (the drop of a broken shulker box). Stable @minecraft/server 2.10.0
// only. Registered by main.ts through `getHandlers(deps)`.
//
//   stuff playerName typeId stacks        -> {name, typeId, stacks, slots}: `stacks` full stacks put into
//                                            the first free slots (one request instead of `stacks` gives)
//   getinv playerName                     -> {name, slots: [{slot, typeId, amount, contents?} | null], counts,
//                                            boxes: [{slot, typeId, total, counts}]}: like truth:inv, plus
//                                            the contents of every item that carries an inventory
//                                            (ItemInventoryComponent, 'minecraft:inventory')
//   boxitems x y z r                       -> {items: [{entityId, typeId, amount, location, contents?}]}:
//                                            item entities within r with their nested contents
import { EntityComponentTypes, ItemStack, Player, world, type Dimension, type EntityInventoryComponent, type EntityItemComponent } from '@minecraft/server';
import { TruthError, exactPos, int, nsId, num } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface GetDeps {
  overworld(): Dimension;
}

type GetHandler = (args: string[]) => unknown;

export interface Contents {
  total: number;
  counts: Record<string, number>;
  stacks: number;
}

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

/** The items inside an item (shulker box, bundle), or undefined when it has no inventory component. */
export function contentsOf(it: ItemStack): Contents | { error: string } | undefined {
  let comp: { container: { size: number; getItem(i: number): ItemStack | undefined } } | undefined;
  try {
    comp = it.getComponent('minecraft:inventory') as unknown as typeof comp;
  } catch (e) {
    return { error: String(e) };
  }
  if (!comp) return undefined;
  try {
    const c = comp.container;
    const counts: Record<string, number> = {};
    let total = 0;
    let stacks = 0;
    for (let i = 0; i < c.size; i++) {
      const x = c.getItem(i);
      if (!x) continue;
      counts[x.typeId] = (counts[x.typeId] ?? 0) + x.amount;
      total += x.amount;
      stacks++;
    }
    return { total, counts, stacks };
  } catch (e) {
    return { error: String(e) };
  }
}

export function getHandlers(deps: GetDeps): Record<string, GetHandler> {
  const { overworld } = deps;
  return {
    stuff(args) {
      const p = player(args[0]);
      const typeId = args[1];
      if (!typeId) throw new TruthError('bad_args', 'usage: stuff playerName typeId stacks');
      const want = int(args[2], 'stacks');
      const id = nsId(typeId);
      const c = inventory(p);
      const max = new ItemStack(id, 1).maxAmount;
      const slots: number[] = [];
      for (let i = 0; i < c.size && slots.length < want; i++) {
        if (c.getItem(i)) continue;
        c.setItem(i, new ItemStack(id, max));
        slots.push(i);
      }
      if (slots.length < want) throw new TruthError('inventory_full', `only ${slots.length} of ${want} stacks fit`, { slots });
      return { name: p.name, typeId: id, stacks: slots.length, slots };
    },

    getinv(args) {
      const p = player(args[0]);
      const c = inventory(p);
      const slots: ({ slot: number; typeId: string; amount: number; contents?: unknown } | null)[] = [];
      const counts: Record<string, number> = {};
      const boxes: { slot: number; typeId: string; total: number; counts: Record<string, number>; stacks: number }[] = [];
      for (let i = 0; i < c.size; i++) {
        const it = c.getItem(i);
        if (!it) {
          slots.push(null);
          continue;
        }
        counts[it.typeId] = (counts[it.typeId] ?? 0) + it.amount;
        const contents = contentsOf(it);
        slots.push({ slot: i, typeId: it.typeId, amount: it.amount, ...(contents ? { contents } : {}) });
        if (contents && !('error' in contents)) boxes.push({ slot: i, typeId: it.typeId, ...contents });
      }
      return { name: p.name, size: c.size, slots, counts, boxes };
    },

    boxitems(args) {
      const at = exactPos(args, 0);
      if (args[3] === undefined) throw new TruthError('bad_args', 'usage: boxitems x y z r');
      const r = num(args[3], 'r');
      const items: { entityId: string; typeId: string; amount: number; location: { x: number; y: number; z: number }; contents?: unknown }[] = [];
      for (const e of overworld().getEntities({ location: at, maxDistance: r, type: 'minecraft:item' })) {
        const it = (e.getComponent(EntityComponentTypes.Item) as EntityItemComponent | undefined)?.itemStack;
        if (!it) continue;
        const contents = contentsOf(it);
        items.push({ entityId: e.id, typeId: it.typeId, amount: it.amount, location: { x: e.location.x, y: e.location.y, z: e.location.z }, ...(contents ? { contents } : {}) });
      }
      return { items };
    },
  };
}
