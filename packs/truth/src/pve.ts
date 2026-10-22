// PvE / follow commands (PLAN.md tasks 7.4 and 7.5, docs/pve.md): summon and list mobs, read and
// set health, move a mob, apply effects, and a server-side log of every hurt event so tests can count
// which of the bot's attacks the server accepted. Stable @minecraft/server 2.10.0 only. Registered
// by main.ts through `pveHandlers(deps)`; see ../README.md ("PvE commands").
import { EntityComponentTypes, Player, system, world, type Dimension, type Entity, type EntityHealthComponent } from '@minecraft/server';
import { TruthError, exactPos, int, nsId, num, type Vec3 } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface PveDeps {
  overworld(): Dimension;
}

interface PveCtx {
  cmd: string;
  id: string | null;
  async: boolean;
}

type PveHandler = (args: string[], ctx: PveCtx) => unknown;

/** Every mob spawned by `summon` carries this tag (plus the caller's own tag). */
export const PVE_TAG = 'truth_pve';
/** Hurt events kept for `hurtlog`. */
const HURT_LOG_SIZE = 1000;

export interface HurtRecord {
  tick: number;
  victimId: string;
  victimType: string;
  victimName: string | null;
  damage: number;
  cause: string;
  damagerId: string | null;
  damagerType: string | null;
  damagerName: string | null;
  healthAfter: number | null;
}

const hurtLog: HurtRecord[] = [];

function healthOf(e: Entity): number | null {
  try {
    const h = e.getComponent(EntityComponentTypes.Health) as EntityHealthComponent | undefined;
    return h ? h.currentValue : null;
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

function vec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function entityState(e: Entity) {
  return {
    entityId: e.id,
    typeId: e.typeId,
    name: nameOf(e),
    location: vec(e.location),
    health: healthOf(e),
    tags: e.getTags(),
  };
}

world.afterEvents.entityHurt.subscribe((ev) => {
  try {
    const v = ev.hurtEntity;
    const d = ev.damageSource.damagingEntity;
    hurtLog.push({
      tick: system.currentTick,
      victimId: v.id,
      victimType: v.typeId,
      victimName: nameOf(v),
      damage: ev.damage,
      cause: ev.damageSource.cause,
      damagerId: d?.id ?? null,
      damagerType: d?.typeId ?? null,
      damagerName: nameOf(d),
      healthAfter: healthOf(v),
    });
    if (hurtLog.length > HURT_LOG_SIZE) hurtLog.splice(0, hurtLog.length - HURT_LOG_SIZE);
  } catch {
    // never let logging break the game
  }
});

function entityById(id: string | undefined): Entity {
  if (!id) throw new TruthError('bad_args', 'missing entityId');
  const e = world.getEntity(id);
  if (!e || !e.isValid) throw new TruthError('entity_not_found', `no entity ${id}`, { entityId: id });
  return e;
}

/** An entity id, or a player name. */
function entityOrPlayer(ref: string | undefined): Entity {
  if (!ref) throw new TruthError('bad_args', 'missing entityId or player name');
  const players = world.getPlayers({ name: ref });
  if (players.length > 0) return players[0]!;
  return entityById(ref);
}

/** Entities summoned by `summon` with `tag` (`*` = every summoned one), optionally of one type. */
function tagged(dim: Dimension, tag: string, type?: string): Entity[] {
  return dim.getEntities({ tags: [tag === '*' ? PVE_TAG : tag], ...(type ? { type: nsId(type) } : {}) });
}

export function pveHandlers(deps: PveDeps): Record<string, PveHandler> {
  const { overworld } = deps;
  return {
    /**
     * summon typeId x y z [tag] -> {entityId, typeId, location, health, tags}
     * Spawns a mob (fractions kept) tagged `truth_pve` and `tag`.
     */
    summon(args) {
      const type = args[0];
      if (!type) throw new TruthError('bad_args', 'usage: summon typeId x y z [tag]');
      const at = exactPos(args, 1);
      const e = overworld().spawnEntity(nsId(type), at);
      e.addTag(PVE_TAG);
      if (args[4]) e.addTag(args[4]);
      return entityState(e);
    },

    /** mobs tag|* [typeId] -> {mobs: [{entityId, typeId, location, health, tags}]} (summoned mobs only). */
    mobs(args) {
      const tag = args[0] ?? '*';
      return { mobs: tagged(overworld(), tag, args[1]).map(entityState) };
    },

    /** near x y z r [typeId] -> every non-player entity within r (natural spawns too). */
    near(args) {
      const at = exactPos(args, 0);
      const r = num(args[3], 'r');
      const list = overworld()
        .getEntities({ location: at, maxDistance: r, excludeTypes: ['minecraft:player'], ...(args[4] ? { type: nsId(args[4]) } : {}) })
        .map(entityState);
      return { mobs: list };
    },

    /** entity entityId|playerName -> {entityId, typeId, location, health, valid} ({valid:false} when gone). */
    entity(args) {
      const ref = args[0];
      if (!ref) throw new TruthError('bad_args', 'usage: entity entityId|playerName');
      const players = world.getPlayers({ name: ref });
      const e = players[0] ?? world.getEntity(ref);
      if (!e || !e.isValid) return { entityId: ref, valid: false };
      return { ...entityState(e), valid: true };
    },

    /** killmobs tag|* -> {removed} (removes summoned mobs without drops). */
    killmobs(args) {
      const list = tagged(overworld(), args[0] ?? '*');
      for (const e of list) e.remove();
      return { removed: list.length };
    },

    /** clearmobs x y z r -> {removed}: removes every non-player entity (mobs, items, arrows) within r. */
    clearmobs(args) {
      const at = exactPos(args, 0);
      const r = num(args[3], 'r');
      const list = overworld().getEntities({ location: at, maxDistance: r, excludeTypes: ['minecraft:player'] });
      for (const e of list) e.remove();
      return { removed: list.length };
    },

    /** sethealth entityId|playerName value -> {entityId, health} */
    sethealth(args) {
      const e = entityOrPlayer(args[0]);
      const value = num(args[1], 'value');
      const h = e.getComponent(EntityComponentTypes.Health) as EntityHealthComponent | undefined;
      if (!h) throw new TruthError('error', `${e.typeId} has no health`);
      h.setCurrentValue(value);
      return { entityId: e.id, name: nameOf(e), health: h.currentValue };
    },

    /** movemob entityId x y z -> {entityId, location}: teleports a mob (fractions kept). */
    movemob(args) {
      const e = entityById(args[0]);
      const to = exactPos(args, 1);
      e.teleport(to);
      return { entityId: e.id, location: to };
    },

    /** effect entityId|playerName effect seconds [amplifier] -> {entityId, effect} */
    effect(args) {
      const e = entityOrPlayer(args[0]);
      const effect = args[1];
      if (!effect) throw new TruthError('bad_args', 'usage: effect entityId|playerName effect seconds [amplifier]');
      const seconds = int(args[2], 'seconds');
      const amplifier = args[3] === undefined ? 0 : int(args[3], 'amplifier');
      e.addEffect(effect, seconds * 20, { amplifier, showParticles: false });
      return { entityId: e.id, effect, seconds, amplifier };
    },

    /**
     * hurtlog [sinceTick] [victimId|damagerName|*] -> {now, events: HurtRecord[]}
     * Server-side record of every entityHurt (damage, cause, damager), newest last.
     */
    hurtlog(args) {
      const since = args[0] === undefined ? 0 : int(args[0], 'sinceTick');
      const who = args[1] && args[1] !== '*' ? args[1] : undefined;
      const events = hurtLog.filter((h) => h.tick >= since && (!who || h.victimId === who || h.damagerName === who || h.victimName === who || h.damagerId === who));
      return { now: system.currentTick, events };
    },
  };
}
