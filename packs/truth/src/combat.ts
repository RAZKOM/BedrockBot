// Combat log commands (Track V, wave 7, docs/pve.md "Truth requests"): a server-side record of what
// matters for keeping the bot alive in a fight, so the e2e suites can measure it instead of guessing:
//   - every melee hit a player lands (entityHitEntity) with the item the player held at that moment;
//   - every creeper behaviour trigger (dataDrivenEntityTrigger: start / stop exploding) with the
//     distance to the nearest player when it fired (the real fuse distance);
//   - every explosion with its source and the distance of every player within 16 blocks;
//   - every projectile that hits a player (arrows, tridents) with its shooter;
//   - (Track M1) every arrow, trident and potion spawned within 40 of a player (throw) and where it ended (land).
// Stable @minecraft/server 2.10.0 only. Registered by main.ts through `combatHandlers(deps)`.
//
//   combatlog [sinceTick] [playerName|*] -> {now, events: CombatRecord[]}
//   held playerName                      -> {name, selectedSlot, typeId, amount}
import { EnchantmentTypes, EntityComponentTypes, EntityDamageCause, ItemComponentTypes, ItemStack, Player, system, world, type Dimension, type Entity, type EntityInventoryComponent, type ItemEnchantableComponent, type Vector3 } from '@minecraft/server';
import { TruthError, int } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface CombatDeps {
  overworld(): Dimension;
}

type CombatHandler = (args: string[]) => unknown;

export interface CombatRecord {
  tick: number;
  kind: 'hit' | 'trigger' | 'explosion' | 'projectile' | 'throw' | 'land';
  /** hit / projectile: the player; trigger: the nearest player. */
  player: string | null;
  /** hit: the victim; trigger / explosion: the creeper (source); projectile: the shooter. */
  entityId: string | null;
  typeId: string | null;
  /** hit: the item in the player's selected slot; projectile: the projectile type. */
  item: string | null;
  selectedSlot: number | null;
  /** trigger: the event id (minecraft:start_exploding, ...). */
  eventId: string | null;
  /** trigger: distance (feet to feet) to the nearest player; projectile: shooter to player. */
  distance: number | null;
  location: Vector3 | null;
  /** explosion: players within 16 blocks of the source and their distance. */
  players: { name: string; distance: number }[] | null;
  /** throw (Track M1): the projectile's velocity at its spawn; the shooter's type in `item`. */
  velocity?: Vector3 | null;
}

const LOG_SIZE = 1000;
const log: CombatRecord[] = [];

function push(r: Partial<CombatRecord> & Pick<CombatRecord, 'kind'>): void {
  log.push({ tick: system.currentTick, player: null, entityId: null, typeId: null, item: null, selectedSlot: null, eventId: null, distance: null, location: null, players: null, ...r });
  if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
}

const d3 = (a: Vector3, b: Vector3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const v = (p: Vector3): Vector3 => ({ x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) });

function heldOf(p: Player): { item: string | null; slot: number } {
  const c = (p.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined)?.container;
  const slot = p.selectedSlotIndex;
  return { item: c?.getItem(slot)?.typeId ?? null, slot };
}

function nearestPlayer(e: Entity): { name: string; distance: number } | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const p of world.getPlayers()) {
    if (p.dimension.id !== e.dimension.id) continue;
    const d = d3(p.location, e.location);
    if (!best || d < best.distance) best = { name: p.name, distance: +d.toFixed(3) };
  }
  return best;
}

world.afterEvents.entityHitEntity.subscribe((ev) => {
  try {
    const p = ev.damagingEntity;
    if (!(p instanceof Player)) return;
    const h = heldOf(p);
    push({ kind: 'hit', player: p.name, entityId: ev.hitEntity.id, typeId: ev.hitEntity.typeId, item: h.item, selectedSlot: h.slot, distance: +d3(p.location, ev.hitEntity.location).toFixed(3) });
  } catch {
    // never let logging break the game
  }
});

world.afterEvents.dataDrivenEntityTrigger.subscribe((ev) => {
  try {
    const e = ev.entity;
    if (e.typeId !== 'minecraft:creeper') return;
    const n = nearestPlayer(e);
    push({ kind: 'trigger', player: n?.name ?? null, entityId: e.id, typeId: e.typeId, eventId: ev.eventId, distance: n?.distance ?? null, location: v(e.location) });
  } catch {
    // never let logging break the game
  }
});

world.afterEvents.explosion.subscribe((ev) => {
  try {
    const s = ev.source;
    const at = s?.isValid ? s.location : undefined;
    const players = at ? world.getPlayers().filter((p) => p.dimension.id === ev.dimension.id && d3(p.location, at) <= 16).map((p) => ({ name: p.name, distance: +d3(p.location, at).toFixed(3) })) : [];
    push({ kind: 'explosion', entityId: s?.id ?? null, typeId: s?.typeId ?? null, location: at ? v(at) : null, players });
  } catch {
    // never let logging break the game
  }
});

// Track M1: every arrow, trident or potion spawned near a player (throw: the projectile's id and type, its spawn point and
// velocity, the shooter's type in `item`, the nearest player and the distance) and where it ended (land: on a block or
// an entity), so the probes can time a throw's flight and see whether the shooter leads its aim.
const THROWN = new Set(['minecraft:arrow', 'minecraft:splash_potion', 'minecraft:lingering_potion', 'minecraft:thrown_trident']);
world.afterEvents.entitySpawn.subscribe((ev) => {
  try {
    const e = ev.entity;
    if (!e.isValid || !THROWN.has(e.typeId)) return;
    const n = nearestPlayer(e);
    if (!n || n.distance > 40) return;
    let owner: string | null = null;
    try {
      owner = (e.getComponent(EntityComponentTypes.Projectile) as { owner?: Entity } | undefined)?.owner?.typeId ?? null;
    } catch {
      owner = null;
    }
    push({ kind: 'throw', player: n.name, entityId: e.id, typeId: e.typeId, item: owner, distance: n.distance, location: v(e.location), velocity: v(e.getVelocity()) });
  } catch {
    // never let logging break the game
  }
});
world.afterEvents.projectileHitBlock.subscribe((ev) => {
  try {
    const pr = ev.projectile;
    if (!THROWN.has(pr.typeId)) return;
    push({ kind: 'land', entityId: pr.id, typeId: pr.typeId, location: v(ev.location), item: 'block' });
  } catch {
    // never let logging break the game
  }
});

world.afterEvents.projectileHitEntity.subscribe((ev) => {
  try {
    const hit = ev.getEntityHit().entity;
    if (ev.projectile && THROWN.has(ev.projectile.typeId)) push({ kind: 'land', entityId: ev.projectile.id, typeId: ev.projectile.typeId, location: v(ev.location), item: hit?.typeId ?? 'entity', player: hit instanceof Player ? hit.name : null });
    if (!(hit instanceof Player)) return;
    const src = ev.source;
    push({
      kind: 'projectile',
      player: hit.name,
      entityId: src?.id ?? null,
      typeId: src?.typeId ?? null,
      item: ev.projectile?.typeId ?? null,
      distance: src?.isValid ? +d3(src.location, hit.location).toFixed(3) : null,
      location: v(ev.location),
    });
  } catch {
    // never let logging break the game
  }
});

// ---- Track M1 (docs/pve.md "Never die to common mobs"): the server's own rules the reflex stands on -------------------
//   meleelog [sinceTick] [player|*]   every hurt with a player on either side: the distance (feet to feet, 3D and level), the
//                                     attacker's view angle off the line to the victim, the victim's velocity a tick later
//   watch ref ticks                   sample an entity's (or a player's) location and velocity every tick for `ticks` ticks
//   watchlog ref [sinceTick]          -> {now, samples: [{tick, location, velocity}]}
//   summonx typeId x y z tag [event] [nameTag]   summon with a spawn event (minecraft:as_baby) and a name
//   givekb player item level [slot]   an item with Knockback `level` (0 = none) into a hotbar slot (default 0)

export interface MeleeRecord {
  tick: number;
  victimId: string;
  victimType: string;
  victimName: string | null;
  damagerId: string | null;
  damagerType: string | null;
  damagerName: string | null;
  damage: number;
  cause: string;
  /** Feet to feet, 3D and level. */
  distance: number | null;
  hdistance: number | null;
  /** Degrees between the damager's view direction (level) and the level line to the victim. */
  viewAngle: number | null;
  /** The victim's velocity one tick after the hurt (knockback). */
  velocity: Vector3 | null;
  victimHealth: number | null;
}

const meleeLog: MeleeRecord[] = [];

function healthOf(e: Entity): number | null {
  try {
    const h = e.getComponent(EntityComponentTypes.Health) as { currentValue: number } | undefined;
    return h ? +h.currentValue.toFixed(3) : null;
  } catch {
    return null;
  }
}

function nameOf(e: Entity | undefined): string | null {
  if (!e) return null;
  try {
    return e instanceof Player ? e.name : e.nameTag || null;
  } catch {
    return null;
  }
}

/** Level angle (degrees) between where `a` looks and the line from `a` to `b`. */
function viewAngleOf(a: Entity, b: Entity): number | null {
  try {
    const v = a.getViewDirection();
    const dx = b.location.x - a.location.x;
    const dz = b.location.z - a.location.z;
    const n1 = Math.hypot(v.x, v.z);
    const n2 = Math.hypot(dx, dz);
    if (n1 < 1e-6 || n2 < 1e-6) return null;
    const c = (v.x * dx + v.z * dz) / (n1 * n2);
    return +((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI).toFixed(1);
  } catch {
    return null;
  }
}

world.afterEvents.entityHurt.subscribe((ev) => {
  try {
    const victim = ev.hurtEntity;
    const d = ev.damageSource.damagingEntity;
    if (!(victim instanceof Player) && !(d instanceof Player)) return;
    const rec: MeleeRecord = {
      tick: system.currentTick,
      victimId: victim.id,
      victimType: victim.typeId,
      victimName: nameOf(victim),
      damagerId: d?.id ?? null,
      damagerType: d?.typeId ?? null,
      damagerName: nameOf(d),
      damage: +ev.damage.toFixed(3),
      cause: ev.damageSource.cause,
      distance: d?.isValid ? +d3(d.location, victim.location).toFixed(3) : null,
      hdistance: d?.isValid ? +Math.hypot(d.location.x - victim.location.x, d.location.z - victim.location.z).toFixed(3) : null,
      viewAngle: d?.isValid ? viewAngleOf(d, victim) : null,
      velocity: null,
      victimHealth: healthOf(victim),
    };
    meleeLog.push(rec);
    if (meleeLog.length > LOG_SIZE) meleeLog.splice(0, meleeLog.length - LOG_SIZE);
    system.runTimeout(() => {
      try {
        if (victim.isValid) rec.velocity = v(victim.getVelocity());
      } catch {
        // gone
      }
    }, 1);
  } catch {
    // never let logging break the game
  }
});

interface WatchSample {
  tick: number;
  location: Vector3;
  velocity: Vector3;
}

const watches = new Map<string, { entity: Entity; left: number; samples: WatchSample[] }>();

system.runInterval(() => {
  for (const [ref, w] of watches) {
    try {
      if (!w.entity.isValid || w.left <= 0) continue;
      w.left--;
      w.samples.push({ tick: system.currentTick, location: v(w.entity.location), velocity: v(w.entity.getVelocity()) });
      if (w.samples.length > 600) w.samples.splice(0, w.samples.length - 600);
    } catch {
      watches.delete(ref);
    }
  }
}, 1);

function refEntity(ref: string | undefined): Entity {
  if (!ref) throw new TruthError('bad_args', 'missing entityId or player name');
  const p = world.getPlayers({ name: ref })[0];
  if (p) return p;
  const e = world.getEntity(ref);
  if (!e || !e.isValid) throw new TruthError('entity_not_found', `no entity ${ref}`);
  return e;
}

export function combatHandlers(deps: CombatDeps): Record<string, CombatHandler> {
  return {
    /** meleelog [sinceTick] [player|*] -> {now, events: MeleeRecord[]} (Track M1). */
    meleelog(args) {
      const since = args[0] === undefined ? 0 : int(args[0], 'sinceTick');
      const who = args[1] && args[1] !== '*' ? args[1] : undefined;
      return { now: system.currentTick, events: meleeLog.filter((r) => r.tick >= since && (!who || r.victimName === who || r.damagerName === who)) };
    },

    /** watch ref ticks -> {ref, ticks}: sample location and velocity every tick (Track M1). */
    watch(args) {
      const e = refEntity(args[0]);
      const ticks = int(args[1], 'ticks');
      const ref = args[0]!;
      const old = watches.get(ref);
      watches.set(ref, { entity: e, left: Math.min(600, ticks), samples: old?.samples ?? [] });
      return { ref, ticks, now: system.currentTick };
    },

    /** watchlog ref [sinceTick] -> {now, samples} (Track M1). */
    watchlog(args) {
      const ref = args[0];
      if (!ref) throw new TruthError('bad_args', 'usage: watchlog ref [sinceTick]');
      const since = args[1] === undefined ? 0 : int(args[1], 'sinceTick');
      return { now: system.currentTick, samples: (watches.get(ref)?.samples ?? []).filter((s) => s.tick >= since) };
    },

    /** summonx typeId x y z tag [event|-] [nameTag] -> {entityId, typeId, location} (Track M1: babies, named mobs). */
    summonx(args) {
      const type = args[0];
      if (!type || args.length < 5) throw new TruthError('bad_args', 'usage: summonx typeId x y z tag [event|-] [nameTag]');
      const at = { x: Number(args[1]), y: Number(args[2]), z: Number(args[3]) };
      if (![at.x, at.y, at.z].every(Number.isFinite)) throw new TruthError('bad_args', 'x y z must be numbers');
      const id = type.includes(':') ? type : `minecraft:${type}`;
      const event = args[5] && args[5] !== '-' ? args[5] : undefined;
      const e = deps.overworld().spawnEntity(id, at, event ? { spawnEvent: event } : undefined);
      e.addTag('truth_pve');
      e.addTag(args[4]!);
      if (args[6]) e.nameTag = args[6];
      return { entityId: e.id, typeId: e.typeId, name: nameOf(e), location: v(e.location), health: healthOf(e), tags: e.getTags() };
    },

    /** anger mobId player -> {entityId}: the mob takes 1 damage from the player (an enderman, a wolf, a piglin turns on them; Track M1). */
    anger(args) {
      const e = refEntity(args[0]);
      const p = world.getPlayers({ name: args[1] ?? '' })[0];
      if (!p) throw new TruthError('player_not_found', `no player ${args[1] ?? ''}`);
      e.applyDamage(1, { cause: EntityDamageCause.entityAttack, damagingEntity: p });
      return { entityId: e.id };
    },

    /** tame mobId player -> {entityId, tamed}: a wolf / cat / parrot tamed to the player (Track M1: the pet left alone). */
    tame(args) {
      const e = refEntity(args[0]);
      const p = world.getPlayers({ name: args[1] ?? '' })[0];
      if (!p) throw new TruthError('player_not_found', `no player ${args[1] ?? ''}`);
      const t = e.getComponent(EntityComponentTypes.Tameable);
      if (!t) throw new TruthError('not_tameable', `${e.typeId} cannot be tamed`);
      const tamed = t.tame(p);
      return { entityId: e.id, tamed };
    },

    /** cleareffects entityId|player -> {entityId, removed}: every effect off (Track M1: a witch's poison between gauntlet cells). */
    cleareffects(args) {
      const e = refEntity(args[0]);
      const removed: string[] = [];
      for (const fx of e.getEffects()) {
        removed.push(fx.typeId);
        e.removeEffect(fx.typeId);
      }
      return { entityId: e.id, removed };
    },

    /** effects entityId|player -> {entityId, effects: [{typeId, amplifier, duration}]} (Track M1: what a witch's potion did). */
    effects(args) {
      const e = refEntity(args[0]);
      return { entityId: e.id, effects: e.getEffects().map((fx) => ({ typeId: fx.typeId, amplifier: fx.amplifier, duration: fx.duration })) };
    },

    /** givekb player item level [slot] -> {slot, typeId, knockback}: an item with Knockback into a hotbar slot (Track M1). */
    givekb(args) {
      const name = args[0];
      const item = args[1];
      if (!name || !item) throw new TruthError('bad_args', 'usage: givekb player item level [slot]');
      const level = int(args[2], 'level');
      const slot = args[3] === undefined ? 0 : int(args[3], 'slot');
      const p = world.getPlayers({ name })[0];
      if (!p) throw new TruthError('player_not_found', `no player ${name}`);
      const stack = new ItemStack(item.includes(':') ? item : `minecraft:${item}`, 1);
      if (level > 0) {
        const ench = stack.getComponent(ItemComponentTypes.Enchantable) as ItemEnchantableComponent | undefined;
        const kb = EnchantmentTypes.get('knockback');
        if (!ench || !kb) throw new TruthError('error', `${item} cannot take knockback`);
        ench.addEnchantment({ type: kb, level });
      }
      const c = (p.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined)?.container;
      if (!c) throw new TruthError('error', 'no inventory');
      c.setItem(slot, stack);
      return { slot, typeId: stack.typeId, knockback: level };
    },

    /** combatlog [sinceTick] [playerName|*] -> {now, events}: hits, creeper triggers, explosions, projectile hits. */
    combatlog(args) {
      const since = args[0] === undefined ? 0 : int(args[0], 'sinceTick');
      const who = args[1] && args[1] !== '*' ? args[1] : undefined;
      const events = log.filter((r) => r.tick >= since && (!who || r.player === who || r.kind === 'explosion'));
      return { now: system.currentTick, events };
    },

    /** held playerName -> {name, selectedSlot, typeId, amount}: the item in the selected hotbar slot. */
    held(args) {
      const name = args[0];
      if (!name) throw new TruthError('bad_args', 'usage: held playerName');
      const p = world.getPlayers({ name })[0];
      if (!p) throw new TruthError('player_not_found', `no player ${name}`);
      const c = (p.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined)?.container;
      const it = c?.getItem(p.selectedSlotIndex);
      return { name: p.name, selectedSlot: p.selectedSlotIndex, typeId: it?.typeId ?? null, amount: it?.amount ?? 0 };
    },
  };
}
