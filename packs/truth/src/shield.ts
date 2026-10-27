// Shield commands (wave 9, Track AH, docs/pve.md "Shield"): what the server thinks of a player's
// stance and offhand, and a log of the hits that reached a player (mob melee swings and projectiles)
// with the stance at that moment, so the e2e suites can tell a blocked hit from a hit that hurt.
// Stable @minecraft/server 2.10.0 only. Registered by main.ts through `shieldHandlers(deps)`.
//
//   stance playerName               -> {name, isSneaking, offhand: {typeId, amount, damage, maxDurability} | null, health, tick}
//   blocklog [sinceTick] [player|*] -> {now, events: [{tick, kind: melee|projectile, player, sneaking, attackerId,
//                                       attackerType, projectile, shieldDamage}]}
import { EntityComponentTypes, EquipmentSlot, ItemComponentTypes, Player, system, world, type Dimension, type EntityEquippableComponent, type EntityHealthComponent, type ItemDurabilityComponent, type ItemStack } from '@minecraft/server';
import { TruthError, int } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface ShieldDeps {
  overworld(): Dimension;
}

type ShieldHandler = (args: string[]) => unknown;

export interface BlockRecord {
  tick: number;
  kind: 'melee' | 'projectile';
  player: string;
  /** Player.isSneaking when the hit arrived (Bedrock raises a held shield while sneaking). */
  sneaking: boolean;
  attackerId: string | null;
  attackerType: string | null;
  projectile: string | null;
  /** Durability damage of the offhand shield right after the hit (null: no shield). */
  shieldDamage: number | null;
}

const LOG_SIZE = 1000;
const log: BlockRecord[] = [];

function offhandOf(p: Player): ItemStack | undefined {
  const eq = p.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
  return eq?.getEquipment(EquipmentSlot.Offhand);
}

function wearOf(it: ItemStack | undefined): { damage: number; maxDurability: number } | undefined {
  const d = it?.getComponent(ItemComponentTypes.Durability) as ItemDurabilityComponent | undefined;
  return d ? { damage: d.damage, maxDurability: d.maxDurability } : undefined;
}

function shieldDamage(p: Player): number | null {
  const it = offhandOf(p);
  return it?.typeId === 'minecraft:shield' ? (wearOf(it)?.damage ?? null) : null;
}

function push(r: Omit<BlockRecord, 'tick' | 'shieldDamage'>, p: Player): void {
  const rec: BlockRecord = { tick: system.currentTick, shieldDamage: null, ...r };
  log.push(rec);
  if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
  // the durability changes after the hit is processed: read it on the next tick
  system.run(() => {
    try {
      if (p.isValid) rec.shieldDamage = shieldDamage(p);
    } catch {
      // never let logging break the game
    }
  });
}

world.afterEvents.entityHitEntity.subscribe((ev) => {
  try {
    const p = ev.hitEntity;
    if (!(p instanceof Player) || ev.damagingEntity instanceof Player) return;
    push({ kind: 'melee', player: p.name, sneaking: p.isSneaking, attackerId: ev.damagingEntity.id, attackerType: ev.damagingEntity.typeId, projectile: null }, p);
  } catch {
    // never let logging break the game
  }
});

world.afterEvents.projectileHitEntity.subscribe((ev) => {
  try {
    const p = ev.getEntityHit().entity;
    if (!(p instanceof Player)) return;
    const src = ev.source;
    push({ kind: 'projectile', player: p.name, sneaking: p.isSneaking, attackerId: src?.id ?? null, attackerType: src?.typeId ?? null, projectile: ev.projectile?.typeId ?? null }, p);
  } catch {
    // never let logging break the game
  }
});

export function shieldHandlers(_deps: ShieldDeps): Record<string, ShieldHandler> {
  return {
    /** stance playerName -> {name, isSneaking, offhand, health, tick}. */
    stance(args) {
      const name = args[0];
      if (!name) throw new TruthError('bad_args', 'usage: stance playerName');
      const p = world.getPlayers({ name })[0];
      if (!p) throw new TruthError('player_not_found', `no player ${name}`, { name });
      const it = offhandOf(p);
      const w = wearOf(it);
      const hp = p.getComponent(EntityComponentTypes.Health) as EntityHealthComponent | undefined;
      return {
        name: p.name,
        isSneaking: p.isSneaking,
        offhand: it ? { typeId: it.typeId, amount: it.amount, damage: w?.damage ?? null, maxDurability: w?.maxDurability ?? null } : null,
        health: hp?.currentValue ?? null,
        tick: system.currentTick,
      };
    },

    /** blocklog [sinceTick] [player|*] -> {now, events}: mob melee hits and projectile hits on players. */
    blocklog(args) {
      const since = args[0] === undefined ? 0 : int(args[0], 'sinceTick');
      const who = args[1] && args[1] !== '*' ? args[1] : undefined;
      return { now: system.currentTick, events: log.filter((r) => r.tick >= since && (!who || r.player === who)) };
    },
  };
}
