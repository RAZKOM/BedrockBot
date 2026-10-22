// Survival-kit commands (PLAN.md task 7.11, Track S, docs/survival.md): read and set food and
// saturation, give worn tools and armour, read durability and the worn equipment, list item entities
// (drops) with their item type, strip the armour, and a server-side log of item use events (start,
// complete, stop, release) so tests can see what the bot's eating packets did. Stable
// @minecraft/server 2.10.0 only. Registered by main.ts through `survHandlers(deps)`; documented in
// docs/survival.md ("Truth commands").
//
//   food playerName                          -> {name, food, saturation, exhaustion, health}
//   setfood playerName food [sat] [exh]      -> the same after setting (sat / exh optional)
//   givedamaged playerName typeId damage [n] -> {name, typeId, damage, maxDurability, slots}: n (1) items with that durability damage
//   setslot playerName slot typeId|air [amount] [damage] -> {name, slot, typeId, amount}: one inventory slot exactly
//   durability playerName                    -> {slots: [{slot, typeId, amount, damage, maxDurability}], equipment: {Head: {...}, ...}}
//   unequip playerName                       -> {removed}: empties the armour and offhand slots
//   items x y z r [typeId]                   -> {items: [{entityId, typeId, amount, location}]}: item entities within r
//   uselog [sinceTick] [playerName|*]        -> {now, events: [{tick, kind, player, typeId, useDuration}]}
import {
  EntityComponentTypes,
  EquipmentSlot,
  ItemComponentTypes,
  ItemStack,
  Player,
  system,
  world,
  type Dimension,
  type EntityEquippableComponent,
  type EntityInventoryComponent,
  type EntityItemComponent,
  type ItemDurabilityComponent,
} from '@minecraft/server';
import { TruthError, exactPos, int, nsId, num } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface SurvDeps {
  overworld(): Dimension;
}

type SurvHandler = (args: string[]) => unknown;

export interface UseRecord {
  tick: number;
  kind: 'start' | 'complete' | 'stop' | 'release';
  player: string;
  typeId: string | null;
  useDuration: number;
}

const USE_LOG_SIZE = 500;
const useLog: UseRecord[] = [];

function logUse(kind: UseRecord['kind'], source: Player, item: ItemStack | undefined, useDuration: number): void {
  try {
    useLog.push({ tick: system.currentTick, kind, player: source.name, typeId: item?.typeId ?? null, useDuration });
    if (useLog.length > USE_LOG_SIZE) useLog.splice(0, useLog.length - USE_LOG_SIZE);
  } catch {
    // never let logging break the game
  }
}

world.afterEvents.itemStartUse.subscribe((ev) => logUse('start', ev.source, ev.itemStack, ev.useDuration));
world.afterEvents.itemCompleteUse.subscribe((ev) => logUse('complete', ev.source, ev.itemStack, ev.useDuration));
world.afterEvents.itemStopUse.subscribe((ev) => logUse('stop', ev.source, ev.itemStack, ev.useDuration));
world.afterEvents.itemReleaseUse.subscribe((ev) => logUse('release', ev.source, ev.itemStack, ev.useDuration));

const ARMOR: EquipmentSlot[] = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand];

function player(name: string | undefined): Player {
  if (!name) throw new TruthError('bad_args', 'missing playerName');
  const ps = world.getPlayers({ name });
  if (ps.length === 0) throw new TruthError('player_not_found', `no player ${name}`, { name });
  return ps[0]!;
}

function attr(p: Player, id: string): { currentValue: number; setCurrentValue(v: number): boolean } | undefined {
  return p.getComponent(id) as unknown as { currentValue: number; setCurrentValue(v: number): boolean } | undefined;
}

function foodState(p: Player) {
  return {
    name: p.name,
    food: attr(p, EntityComponentTypes.Hunger)?.currentValue ?? null,
    saturation: attr(p, EntityComponentTypes.Saturation)?.currentValue ?? null,
    exhaustion: attr(p, EntityComponentTypes.Exhaustion)?.currentValue ?? null,
    health: attr(p, EntityComponentTypes.Health)?.currentValue ?? null,
    tick: system.currentTick,
  };
}

function wear(it: ItemStack | undefined): { damage: number; maxDurability: number } | null {
  if (!it) return null;
  const d = it.getComponent(ItemComponentTypes.Durability) as ItemDurabilityComponent | undefined;
  return d ? { damage: d.damage, maxDurability: d.maxDurability } : null;
}

function inventory(p: Player) {
  const c = (p.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined)?.container;
  if (!c) throw new TruthError('error', `player ${p.name} has no inventory container`);
  return c;
}

function equippable(p: Player): EntityEquippableComponent | undefined {
  return p.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
}

export function survHandlers(deps: SurvDeps): Record<string, SurvHandler> {
  const { overworld } = deps;
  return {
    food(args) {
      return foodState(player(args[0]));
    },

    setfood(args) {
      const p = player(args[0]);
      if (args[1] === undefined) throw new TruthError('bad_args', 'usage: setfood playerName food [saturation] [exhaustion]');
      attr(p, EntityComponentTypes.Hunger)?.setCurrentValue(num(args[1], 'food'));
      if (args[2] !== undefined) attr(p, EntityComponentTypes.Saturation)?.setCurrentValue(num(args[2], 'saturation'));
      if (args[3] !== undefined) attr(p, EntityComponentTypes.Exhaustion)?.setCurrentValue(num(args[3], 'exhaustion'));
      return foodState(p);
    },

    givedamaged(args) {
      const p = player(args[0]);
      const typeId = args[1];
      if (!typeId || args[2] === undefined) throw new TruthError('bad_args', 'usage: givedamaged playerName typeId damage [amount]');
      const damage = int(args[2], 'damage');
      const n = args[3] === undefined ? 1 : int(args[3], 'amount');
      const c = inventory(p);
      const out: { slot: number }[] = [];
      let maxDurability = 0;
      for (let i = 0; i < n; i++) {
        let st: ItemStack;
        try {
          st = new ItemStack(nsId(typeId), 1);
        } catch (e) {
          throw new TruthError('unknown_item', `unknown item ${typeId}: ${String(e)}`, { typeId });
        }
        const d = st.getComponent(ItemComponentTypes.Durability) as ItemDurabilityComponent | undefined;
        if (!d) throw new TruthError('no_durability', `${typeId} has no durability`, { typeId });
        maxDurability = d.maxDurability;
        d.damage = Math.max(0, Math.min(damage, d.maxDurability));
        let slot = -1;
        for (let s = 0; s < c.size; s++) {
          if (!c.getItem(s)) {
            slot = s;
            break;
          }
        }
        if (slot < 0) throw new TruthError('inventory_full', 'no empty slot');
        c.setItem(slot, st);
        out.push({ slot });
      }
      return { name: p.name, typeId: nsId(typeId), damage, maxDurability, slots: out.map((o) => o.slot) };
    },

    setslot(args) {
      const p = player(args[0]);
      if (args[1] === undefined || !args[2]) throw new TruthError('bad_args', 'usage: setslot playerName slot typeId|air [amount] [damage]');
      const slot = int(args[1], 'slot');
      const c = inventory(p);
      if (slot < 0 || slot >= c.size) throw new TruthError('bad_args', `slot must be in [0, ${c.size - 1}]`);
      if (args[2] === 'air' || args[2] === 'minecraft:air') {
        c.setItem(slot, undefined);
        return { name: p.name, slot, typeId: null };
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
      c.setItem(slot, st);
      return { name: p.name, slot, typeId: st.typeId, amount: st.amount };
    },

    durability(args) {
      const p = player(args[0]);
      const c = inventory(p);
      const slots: { slot: number; typeId: string; amount: number; damage: number; maxDurability: number }[] = [];
      for (let i = 0; i < c.size; i++) {
        const it = c.getItem(i);
        const w = wear(it);
        if (it && w) slots.push({ slot: i, typeId: it.typeId, amount: it.amount, ...w });
      }
      const equipment: Record<string, { typeId: string; damage: number | null; maxDurability: number | null }> = {};
      const eq = equippable(p);
      if (eq) {
        for (const s of ARMOR) {
          const it = eq.getEquipment(s);
          if (it) {
            const w = wear(it);
            equipment[s] = { typeId: it.typeId, damage: w?.damage ?? null, maxDurability: w?.maxDurability ?? null };
          }
        }
      }
      return { name: p.name, slots, equipment };
    },

    unequip(args) {
      const p = player(args[0]);
      const eq = equippable(p);
      let removed = 0;
      if (eq) {
        for (const s of ARMOR) {
          if (eq.getEquipment(s)) {
            eq.setEquipment(s, undefined);
            removed++;
          }
        }
      }
      return { name: p.name, removed };
    },

    items(args) {
      const at = exactPos(args, 0);
      if (args[3] === undefined) throw new TruthError('bad_args', 'usage: items x y z r [typeId]');
      const r = num(args[3], 'r');
      const want = args[4] ? nsId(args[4]) : undefined;
      const items: { entityId: string; typeId: string; amount: number; location: { x: number; y: number; z: number } }[] = [];
      for (const e of overworld().getEntities({ location: at, maxDistance: r, type: 'minecraft:item' })) {
        const it = (e.getComponent(EntityComponentTypes.Item) as EntityItemComponent | undefined)?.itemStack;
        if (!it || (want && it.typeId !== want)) continue;
        items.push({ entityId: e.id, typeId: it.typeId, amount: it.amount, location: { x: e.location.x, y: e.location.y, z: e.location.z } });
      }
      return { items };
    },

    uselog(args) {
      const since = args[0] === undefined ? 0 : num(args[0], 'sinceTick');
      const who = args[1] && args[1] !== '*' ? args[1] : undefined;
      return { now: system.currentTick, events: useLog.filter((e) => e.tick >= since && (!who || e.player === who)) };
    },
  };
}
