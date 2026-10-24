// Target choice for guard mode and flee (Track V, wave 7; docs/pve.md "Targeting"). Moved out of
// tasks/pve.ts (`isThreat`, `nearestHostile`, `pickThreat`), which keeps one-line calls, and made
// reachability-aware after the Realm deaths of 2026-10-29 (a guard fight locked on an unreachable
// phantom while a creeper walked up):
//
// - a candidate must be (a) within reach now (eye to box <= 3.2), or (b) standing on, or at most 1.5
//   blocks above, a cell the planner can stand in (NavGrid.stand of the navigator's own grid), within
//   6 blocks of height and the guard radius. Unknown terrain (no grid, chunk not in) counts as (b).
// - flying mobs (FLYING_TYPES: phantom, ghast, vex, blaze, breeze, bee, allay, parrot, bat) only
//   under (a), never chased; one that hit us while out of reach is ignored for 10 s.
// - a creeper within 6 blocks outranks every other target. Below health 10 the bot does not engage
//   creepers: a creeper within 8 blocks is still picked (first), and the combat skill only keeps away
//   from it (`creeper_avoided`); `wantsFlee(threat)` is true for it (Track W's FleeProcess).
// - after a fight: `out_of_range` / `unreachable` ignore the mob for 10 s, `took_cover` 3 s,
//   `creeper_avoided` / `interrupted` not at all, anything else 30 s. The next target
//   is picked on the next manager tick (the ignore never blocks another mob).
import type { Logger } from '../../log.ts';
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import type { TerrainClass } from '../terrain/classify.ts';
import { EYE_HEIGHT, type FightResult } from './combat.ts';
import { bareType, classify, entityFeet, isCreeper, isFlying, isPlayerEntity, reachDistance, type MobTracker } from './hostiles.ts';

/** Eye-to-box distance that counts as "within reach now". */
export const REACH_NOW = 3.2;
/** A creeper this close outranks every other target. */
export const CREEPER_RANK_RANGE = 6;
/** Below CREEPER_MIN_HEALTH a creeper this close is avoided (and wants a flight). */
export const CREEPER_AVOID_RANGE = 8;
/** Below this health the bot does not engage creepers. */
export const CREEPER_MIN_HEALTH = 10;
/** Height difference beyond which a mob is never a guard target. */
export const MAX_DY = 6;
/** How far above a standable cell the mob's feet may be (it stands on a slab, a fence, jumps). */
export const ABOVE_CELL = 1.5;
/** Extra chase distance beyond the guard radius (from the bot). */
export const CHASE_EXTRA = 16;

/** The planner's grid as targeting reads it (NavGrid satisfies it). */
export interface GridLike {
  /** Feet height of a body standing in node (x, y, z); NaN = blocked; undefined = unknown. */
  stand(x: number, y: number, z: number): number | undefined;
  cls(x: number, y: number, z: number): TerrainClass | undefined;
}

/** What the target rules read from the PvE controller (`PveController` satisfies it). */
export interface TargetingHost {
  readonly mobs: MobTracker;
  readonly ignore: Map<bigint, number>;
  readonly d: {
    readonly world: { readonly entities: ReadonlyMap<bigint, EntityInfo> };
    home(): Vec3 | undefined;
    readonly night?: { wantsShelter(): boolean; inside(): boolean; readonly state: string } | undefined;
  };
  readonly processes: { userProcesses(): readonly unknown[] };
  readonly guardRadius: number;
  readonly mover: { readonly nav: { readonly busy: boolean } };
  readonly log: Logger;
  health(): number;
  position(): Vec3;
}

export interface ThreatPick {
  e: EntityInfo;
  inPlace: boolean;
}

/** The navigator's grid behind a mover (BotSkills.nav.grid), if any. */
export function gridOf(mover: { readonly nav: unknown } | undefined): GridLike | undefined {
  const g = (mover?.nav as { grid?: GridLike } | undefined)?.grid;
  return g && typeof g.stand === 'function' ? g : undefined;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Hostiles, plus neutral mobs that hit or target the bot. Never players, items or passive mobs. */
export function isThreat(h: Pick<TargetingHost, 'mobs'>, e: EntityInfo): boolean {
  if (isPlayerEntity(e)) return false;
  const st = h.mobs.get(e.runtimeId);
  if (st?.dead) return false;
  const cls = classify(e.type);
  if (cls === 'hostile') return true;
  if (cls !== 'neutral' && cls !== 'other') return false;
  const hit = h.mobs.lastHitBy;
  return h.mobs.targetsUs(e.runtimeId) || (hit?.runtimeId === e.runtimeId && performance.now() - hit.at < 10_000);
}

/** The nearest threat within r of `me` (3D, feet to feet). */
export function nearestHostile(h: Pick<TargetingHost, 'mobs' | 'd'>, me: Vec3, r: number): EntityInfo | undefined {
  let best: EntityInfo | undefined;
  let bd = Infinity;
  for (const e of h.d.world.entities.values()) {
    if (!isThreat(h, e)) continue;
    const d = dist(entityFeet(e), me);
    if (d <= r && d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

/**
 * Can the bot get at `e`? 'now' = within reach (eye to box <= 3.2); 'cell' = the mob stands on or at
 * most 1.5 blocks above a cell the planner can stand in, within 6 blocks of height (flying mobs never
 * qualify); false = neither. Without a grid, or where the grid does not know the terrain yet, 'cell'.
 */
export function reachability(grid: GridLike | undefined, me: Vec3, e: EntityInfo): 'now' | 'cell' | false {
  const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
  if (reachDistance(eye, e) <= REACH_NOW) return 'now';
  if (isFlying(e.type)) return false;
  const f = entityFeet(e);
  if (Math.abs(f.y - me.y) > MAX_DY) return false;
  if (!grid) return 'cell';
  // the cells under the mob's box (it may overhang an edge by up to 0.3)
  const xs = new Set([Math.floor(f.x), Math.floor(f.x - 0.3), Math.floor(f.x + 0.3)]);
  const zs = new Set([Math.floor(f.z), Math.floor(f.z - 0.3), Math.floor(f.z + 0.3)]);
  const top = Math.floor(f.y + 1e-3);
  const bottom = Math.floor(f.y - ABOVE_CELL);
  for (const x of xs) {
    for (const z of zs) {
      for (let y = top; y >= bottom; y--) {
        const s = grid.stand(x, y, z);
        if (s === undefined) return 'cell';
        if (!Number.isNaN(s) && f.y - s >= -0.1 && f.y - s <= ABOVE_CELL) return 'cell';
      }
    }
  }
  return false;
}

/**
 * The guard target, if any: in place (within reach only) at low health or inside the night shelter.
 * See the file comment for the rules.
 */
export function pickThreat(h: TargetingHost, me: Vec3, low: boolean): ThreatPick | undefined {
  const night = h.d.night;
  let inPlace = low;
  if (night?.wantsShelter()) {
    if (night.inside()) inPlace = true;
    else if (night.state === 'going') return undefined;
  }
  const home = h.d.home();
  const commanded = h.processes.userProcesses().length > 0;
  const center = !commanded && home && !inPlace ? { x: home.x + 0.5, y: home.y, z: home.z + 0.5 } : me;
  const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
  const now = performance.now();
  const hit = h.mobs.lastHitBy;
  const radius = h.guardRadius;
  const creeperShy = h.health() < CREEPER_MIN_HEALTH;
  const grid = gridOf(h.mover);
  let best: { e: EntityInfo; score: number } | undefined;
  for (const e of h.d.world.entities.values()) {
    if (!isThreat(h, e)) continue;
    if ((h.ignore.get(e.runtimeId) ?? 0) > now) continue;
    const f = entityFeet(e);
    const d = dist(f, me);
    const creeper = isCreeper(e.type);
    const hitUs = hit?.runtimeId === e.runtimeId && now - hit.at < 10_000;
    let score = d;
    if (creeper && creeperShy) {
      // below health 10: never engaged; a near one is picked first so the combat skill keeps away from it
      if (inPlace || d > CREEPER_AVOID_RANGE) continue;
      score -= 2000;
    } else if (inPlace) {
      if (reachDistance(eye, e) > REACH_NOW) continue;
    } else {
      if (dist(f, center) > radius || d > radius + CHASE_EXTRA) continue;
      if (Math.abs(f.y - me.y) > MAX_DY) continue;
      if (!reachability(grid, me, e)) {
        if (hitUs && isFlying(e.type)) {
          h.ignore.set(e.runtimeId, now + 10_000);
          h.log.info(`guard: ${bareType(e.type)} #${e.runtimeId} hit us out of reach (flying): ignored for 10 s`);
        }
        continue;
      }
    }
    if (creeper && d <= CREEPER_RANK_RANGE) score -= 1000;
    if (hitUs) score -= 100;
    else if (h.mobs.targetsUs(e.runtimeId)) score -= 50;
    if (!best || score < best.score) best = { e, score };
  }
  return best ? { e: best.e, inPlace } : undefined;
}

/**
 * Track W's flee trigger from this side: a creeper within 8 blocks while the health is below 10 (the
 * bot does not engage it; the combat skill only keeps away, reporting `creeper_avoided`).
 */
export function wantsFlee(h: Pick<TargetingHost, 'health' | 'position'>, threat: EntityInfo): boolean {
  if (!isCreeper(threat.type) || h.health() >= CREEPER_MIN_HEALTH || h.health() <= 0) return false;
  return dist(entityFeet(threat), h.position()) <= CREEPER_AVOID_RANGE;
}

/** How long (ms) a mob is not picked again after a fight that ended `reason`; 0 = not ignored. */
export function ignoreMsAfter(reason: FightResult['reason']): number {
  switch (reason) {
    case 'killed':
    case 'creeper_avoided':
    case 'interrupted':
      return 0;
    case 'out_of_range':
    case 'unreachable':
      return 10_000;
    case 'took_cover':
      return 3_000;
    default:
      return 30_000;
  }
}

/** Apply the ignore rule for a finished guard fight. */
export function afterFight(h: Pick<TargetingHost, 'ignore'>, e: EntityInfo, r: Pick<FightResult, 'reason'>): void {
  const ms = ignoreMsAfter(r.reason);
  if (ms > 0) h.ignore.set(e.runtimeId, performance.now() + ms);
}
