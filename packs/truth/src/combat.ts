// Combat log commands (Track V, wave 7, docs/pve.md "Truth requests"): a server-side record of what
// matters for keeping the bot alive in a fight, so the e2e suites can measure it instead of guessing:
//   - every melee hit a player lands (entityHitEntity) with the item the player held at that moment;
//   - every creeper behaviour trigger (dataDrivenEntityTrigger: start / stop exploding) with the
//     distance to the nearest player when it fired (the real fuse distance);
//   - every explosion with its source and the distance of every player within 16 blocks;
//   - every projectile that hits a player (arrows, tridents) with its shooter.
// Stable @minecraft/server 2.10.0 only. Registered by main.ts through `combatHandlers(deps)`.
//
//   combatlog [sinceTick] [playerName|*] -> {now, events: CombatRecord[]}
//   held playerName                      -> {name, selectedSlot, typeId, amount}
import { EntityComponentTypes, Player, system, world, type Dimension, type Entity, type EntityInventoryComponent, type Vector3 } from '@minecraft/server';
import { TruthError, int } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface CombatDeps {
  overworld(): Dimension;
}

type CombatHandler = (args: string[]) => unknown;

export interface CombatRecord {
  tick: number;
  kind: 'hit' | 'trigger' | 'explosion' | 'projectile';
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

world.afterEvents.projectileHitEntity.subscribe((ev) => {
  try {
    const hit = ev.getEntityHit().entity;
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

export function combatHandlers(_deps: CombatDeps): Record<string, CombatHandler> {
  return {
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
