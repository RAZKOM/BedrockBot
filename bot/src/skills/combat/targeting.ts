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
//
// Track AH (wave 9, combat v3, docs/pve.md "Targeting", decision 0029):
// - inside a fight the target is re-picked among the threats within reach (eye to box <= 3.2) on
//   every strike cycle (`pickInReach`): the mob that hit us in the last 10 s first, then a creeper,
//   then the nearest; the current target keeps a 0.3-block bonus so two equidistant mobs do not
//   flap. A target that leaves reach while another threat is in reach is dropped at once.
// - crowd rule (`crowdOf`, `crowded`): 3 or more melee threats within 4 blocks and health below 12:
//   the fight ends `crowded` and `wantsFlee` is true for them (the flee trigger, like a creeper).
//
// Track AO (wave 9, docs/pve.md "Path-reachable targets", decision 0036): "it gets stuck trying to
// fight mobs behind walls when on its way to places".
// - within reach now also needs a line of sight (eye to the mob's upper body or head, no solid cell
//   between: a zombie pressed against a glass wall is in reach but cannot be hit nor hit back);
// - a candidate not within reach gets a bounded probe plan (pathReach.ts) to a cell next to it; no path,
//   or a path longer than `guardReach` (24 path blocks; 0 = the old terrain rule only), ignores it for
//   30 s (`ignoreWhy` keeps the reason) and the next candidate is looked at in the same evaluation.
//   While a better-ranked candidate's probe runs, only mobs within reach are picked.
// - while a user process walks (`guardWhileWalking`, default 'near'): only a mob within reach, or a
//   melee threat / creeper / archer that targets the bot within 6 path blocks ('near'); 'reach' =
//   within reach only; 'all' = as without a walk (the probe rule still applies).
// - `unreachable` after a fight ignores the mob for 30 s (was 10); a mob that hit the bot after it was
//   ignored is a target again (not a flying one).
import type { Logger } from '../../log.ts';
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import type { TerrainClass } from '../terrain/classify.ts';
import { EYE_HEIGHT, type FightResult } from './combat.ts';
import { aimPoint, bareType, classify, entityFeet, entitySize, isArcher, isCreeper, isFlying, isPlayerEntity, RANGED_TYPES, reachDistance, type MobTracker } from './hostiles.ts';
import { PROBE_GOAL_R, type PathVerdict } from './pathReach.ts'; // Track AO

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

/** Track AH: how long a hit makes its mob the first choice within reach (ms). */
export const HIT_MEMORY_MS = 10_000;
/** Track AH: the current target's bonus (blocks) when the target is re-picked within reach. */
export const RETARGET_BONUS = 0.3;
/** Track AH: the crowd rule: this many melee threats ... */
export const CROWD_COUNT = 3;
/** ... within this distance (3D, feet to feet) ... */
export const CROWD_RANGE = 4;
/** ... with the health below this end the fight `crowded` and want a flight. */
export const CROWD_HEALTH = 12;

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
  readonly processes: { userProcesses(): readonly { readonly name: string }[]; readonly paused?: boolean }; // Track AO: names, !pause
  /** Track AO: max path length (blocks) to a guard target not within reach; 0 = the terrain rule only. Default 0 (no probes). */
  readonly guardReach?: number;
  /** Track AO: who guard may engage while a user process walks. Default 'all' (as without a walk). */
  readonly guardWhileWalking?: WalkRule;
  /** Track AO: the probe plans (cached verdicts). Without it no path rule applies. */
  readonly pathReach?: { lookup(e: EntityInfo, me: Vec3): PathVerdict | 'pending' | 'none' };
  /** Track AO: why and since when a mob is ignored (status, the hit rule). */
  readonly ignoreWhy?: Map<bigint, IgnoreNote>;
  readonly guardRadius: number;
  readonly mover: { readonly nav: { readonly busy: boolean } };
  readonly log: Logger;
  health(): number;
  position(): Vec3;
  /** Track AH: the combat skill's switches (`crowdRule` false turns the crowd rule off for both sides). */
  readonly combat?: { readonly crowdRule?: boolean; readonly busy?: boolean; readonly crowdedRecently?: boolean };
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

/** Track AT: some worn armour piece is golden (window 120 of the world model's inventory; piglins stay calm). */
export function wearsGold(world: object): boolean {
  const inv = (world as { inventory?: { window?(id: number): { slots: readonly ({ name: string } | null)[] } | undefined } }).inventory;
  return inv?.window?.(120)?.slots.some((s) => !!s && s.name.startsWith('golden_')) ?? false;
}

/** Hostiles, plus neutral mobs that hit or target the bot. Never players, items or passive mobs. */
export function isThreat(h: Pick<TargetingHost, 'mobs'> & { readonly d?: { readonly world: object } }, e: EntityInfo): boolean {
  if (isPlayerEntity(e)) return false;
  const st = h.mobs.get(e.runtimeId);
  if (st?.dead) return false;
  const cls = classify(e.type);
  if (cls === 'hostile') return true;
  if (cls !== 'neutral' && cls !== 'other') return false;
  // Track AT: a piglin (not a brute) is never fought while the bot wears gold: hitting one turns the whole group
  if (bareType(e.type) === 'piglin' && h.d && wearsGold(h.d.world)) return false;
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
  const cands: Candidate[] = [];
  for (const e of h.d.world.entities.values()) {
    if (!isThreat(h, e)) continue;
    const hitUs = hit?.runtimeId === e.runtimeId && now - hit.at < 10_000;
    if ((h.ignore.get(e.runtimeId) ?? 0) > now) {
      // Track AO: a mob that hit the bot after it was ignored is reachable after all (not a flying one)
      const note = h.ignoreWhy?.get(e.runtimeId);
      if (!hitUs || !note || hit.at <= note.at || isFlying(e.type)) continue;
      h.ignore.delete(e.runtimeId);
      h.ignoreWhy?.delete(e.runtimeId);
      h.log.info(`guard: ${bareType(e.type)} #${e.runtimeId} hit us: no longer ignored (was: ${note.reason})`);
    }
    const f = entityFeet(e);
    const d = dist(f, me);
    const creeper = isCreeper(e.type);
    let score = d;
    let kind: Candidate['kind'] = 'chase';
    if (creeper && creeperShy) {
      // below health 10: never engaged; a near one is picked first so the combat skill keeps away from it
      if (inPlace || d > CREEPER_AVOID_RANGE) continue;
      score -= 2000;
      kind = 'avoid';
    } else if (inPlace) {
      if (reachDistance(eye, e) > REACH_NOW) continue;
      kind = 'inPlace';
    } else {
      if (dist(f, center) > radius || d > radius + CHASE_EXTRA) continue;
      if (Math.abs(f.y - me.y) > MAX_DY) continue;
      const r = reachability(grid, me, e);
      if (!r) {
        if (hitUs && isFlying(e.type)) {
          h.ignore.set(e.runtimeId, now + 10_000);
          h.ignoreWhy?.set(e.runtimeId, { reason: 'hit us out of reach (flying)', at: now, type: e.type });
          h.log.info(`guard: ${bareType(e.type)} #${e.runtimeId} hit us out of reach (flying): ignored for 10 s`);
        }
        continue;
      }
      if (r === 'now' && (!grid || lineOfSight(grid, eye, e))) kind = 'now'; // Track AO: in reach and nothing solid between
    }
    if (creeper && d <= CREEPER_RANK_RANGE) score -= 1000;
    if (hitUs) score -= 100;
    else if (h.mobs.targetsUs(e.runtimeId)) score -= 50;
    cands.push({ e, score, d, kind });
  }
  if (cands.length === 0) return undefined;
  cands.sort((a, b) => a.score - b.score);
  // Track AO: the path rule, best-ranked first; a candidate that fails it is skipped in the same evaluation
  const walking = userWalking(h);
  let waiting = false;
  for (const c of cands) {
    if (c.kind !== 'chase') return { e: c.e, inPlace };
    if (waiting) continue; // a better candidate's probe runs: only mobs within reach meanwhile
    const g = pathGate(h, c, me, walking);
    if (g === 'yes') return { e: c.e, inPlace };
    if (g === 'pending') waiting = true;
  }
  return undefined;
}

/** A guard candidate (Track AO): 'now' = within reach with a line of sight; 'chase' = needs the path rule. */
interface Candidate {
  e: EntityInfo;
  score: number;
  d: number;
  kind: 'now' | 'chase' | 'inPlace' | 'avoid';
}

// ---- Track AO: path-reachable targets, restraint while walking ----------------------------------

/** Ignore after a failed probe (no path, too long) or an `unreachable` fight (ms). */
export const PATH_IGNORE_MS = 30_000;
/** guardWhileWalking 'near': at most this many path blocks from the bot. */
export const WALK_NEAR = 6;
/** Default of the `guardReach` setting (path blocks). */
export const GUARD_REACH = 24;

/** Who guard engages while a user process walks: within reach only, also near melee threats, or anyone. */
export type WalkRule = 'reach' | 'near' | 'all';
export const WALK_RULES: readonly WalkRule[] = ['reach', 'near', 'all'];

/** `guardWhileWalking` text -> rule (throws on anything else). */
export function parseWalkRule(raw: string): WalkRule {
  const v = raw.trim().toLowerCase();
  if ((WALK_RULES as readonly string[]).includes(v)) return v as WalkRule;
  throw new Error(`guardWhileWalking must be reach, near or all, got "${raw}"`);
}

/** Why and since when (performance.now()) a mob is ignored. */
export interface IgnoreNote {
  reason: string;
  at: number;
  type?: string;
}

/** Ignore `e` for `ms` with a reason (kept in `ignoreWhy` when the host has it). */
export function ignoreMob(h: Pick<TargetingHost, 'ignore' | 'ignoreWhy' | 'log'>, e: Pick<EntityInfo, 'runtimeId' | 'type'>, ms: number, reason: string): void {
  const now = performance.now();
  h.ignore.set(e.runtimeId, now + ms);
  h.ignoreWhy?.set(e.runtimeId, { reason, at: now, type: e.type });
  h.log.info(`guard: ${bareType(e.type)} #${e.runtimeId} ignored for ${Math.round(ms / 1000)} s (${reason})`);
}

/** A user process (not a kill job, not held by !pause) runs: the bot is on its way somewhere. */
export function userWalking(h: Pick<TargetingHost, 'processes'>): boolean {
  if (h.processes.paused) return false;
  return h.processes.userProcesses().some((p) => p.name !== 'kill');
}

/** Melee threat, creeper, or an archer that targets the bot: what guard engages near a walk. */
export function walkThreat(e: EntityInfo, mobs: MobTracker): boolean {
  if (isCreeper(e.type) || isMelee(e, mobs)) return true;
  return isArcher(e, mobs) && mobs.targetsUs(e.runtimeId);
}

/**
 * Nothing solid between the eye and the mob's upper body, head or lower body (a cell whose collision
 * box reaches its top, not leaves; the end cells excluded; combat.ts `blocked` does the same for cover).
 * Glass blocks it; a 1-block window, a fence below the line, a slab do not.
 */
export function lineOfSight(grid: GridLike, eye: Vec3, e: EntityInfo): boolean {
  const f = entityFeet(e);
  const h = entitySize(e.type).h;
  const a = aimPoint(e);
  for (const p of [a, { x: f.x, y: f.y + h * 0.9, z: f.z }, { x: f.x, y: f.y + h * 0.3, z: f.z }]) {
    if (!blockedLine(grid, eye, p)) return true;
  }
  return false;
}

/** The segment a -> b passes through a solid cell (sampled every 0.2 blocks, the end cells excluded). */
function blockedLine(grid: GridLike, a: Vec3, b: Vec3): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.max(2, Math.ceil(d / 0.2));
  const ka = `${Math.floor(a.x)},${Math.floor(a.y)},${Math.floor(a.z)}`;
  const kb = `${Math.floor(b.x)},${Math.floor(b.y)},${Math.floor(b.z)}`;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = Math.floor(a.x + (b.x - a.x) * t);
    const y = Math.floor(a.y + (b.y - a.y) * t);
    const z = Math.floor(a.z + (b.z - a.z) * t);
    const k = `${x},${y},${z}`;
    if (k === ka || k === kb) continue;
    const c = grid.cls(x, y, z);
    if (c && c.boxes.length > 0 && c.top >= 1 && !c.leaves) return true;
  }
  return false;
}

/**
 * The path rule for a candidate not within reach: 'yes' = engage, 'no' = skip it (ignored for 30 s
 * when the probe found no path or one too long), 'pending' = its probe runs.
 */
function pathGate(h: TargetingHost, c: Candidate, me: Vec3, walking: boolean): 'yes' | 'no' | 'pending' {
  const pr = h.pathReach;
  const rule = h.guardWhileWalking ?? 'all';
  const restrained = walking && rule !== 'all';
  let limit: number;
  if (restrained) {
    if (rule === 'reach' || !walkThreat(c.e, h.mobs)) return 'no';
    limit = WALK_NEAR;
  } else {
    limit = h.guardReach ?? 0;
    if (limit <= 0) return 'yes'; // the old terrain rule only
  }
  // a path ends within PROBE_GOAL_R of the mob and starts within about a block of the bot
  if (c.d > limit + PROBE_GOAL_R + 1) return 'no';
  if (!pr) return 'yes';
  const v = pr.lookup(c.e, me);
  if (v === 'pending') return 'pending';
  if (v === 'none') return 'yes';
  if (!v.ok) {
    ignoreMob(h, c.e, PATH_IGNORE_MS, v.reason);
    return 'no';
  }
  if (v.blocks <= limit) return 'yes';
  if (restrained) return 'no'; // reachable, just not near the walk: left alone, not ignored
  ignoreMob(h, c.e, PATH_IGNORE_MS, `path ${Math.round(v.blocks)} blocks > guardReach ${limit}`);
  return 'no';
}

/**
 * Track W's flee trigger from this side: a creeper within 8 blocks while the health is below 10 (the
 * bot does not engage it; the combat skill only keeps away, reporting `creeper_avoided`).
 */
export function wantsFlee(h: Pick<TargetingHost, 'health' | 'position'> & Partial<Pick<CrowdHost, 'mobs' | 'd' | 'combat'>>, threat: EntityInfo): boolean {
  if (h.health() <= 0) return false;
  if (!isCreeper(threat.type)) return h.mobs && h.d ? crowded(h as CrowdHost, h.position()).some((e) => e.runtimeId === threat.runtimeId) : false; // Track AH: the crowd rule
  if (h.health() >= CREEPER_MIN_HEALTH) return false;
  return dist(entityFeet(threat), h.position()) <= CREEPER_AVOID_RANGE;
}

// ---- Track AH: re-targeting within reach, the crowd rule ----------------------------------------

/** A melee threat: not a creeper (its own rules), not an archer or another ranged mob (a drowned without a trident is melee). */
export function isMelee(e: EntityInfo, mobs: Pick<MobTracker, 'get'>): boolean {
  const b = bareType(e.type);
  if (isCreeper(e.type) || isArcher(e, mobs)) return false;
  return !RANGED_TYPES.has(b) || b === 'drowned';
}

/** The melee threats within CROWD_RANGE of `me` (3D, feet to feet). */
export function crowdOf(entities: Iterable<EntityInfo>, mobs: MobTracker, me: Vec3): EntityInfo[] {
  const out: EntityInfo[] = [];
  for (const e of entities) {
    if (!isThreat({ mobs }, e) || !isMelee(e, mobs)) continue;
    if (dist(entityFeet(e), me) <= CROWD_RANGE) out.push(e);
  }
  return out;
}

/** What the crowd rule reads (PveController satisfies it). */
export interface CrowdHost {
  readonly mobs: MobTracker;
  readonly d: { readonly world: { readonly entities: ReadonlyMap<bigint, EntityInfo> } };
  health(): number;
  /** The combat skill: the rule's switch; while it fights, the fight decides (it ends `crowded`, then the flight comes). */
  readonly combat?: { readonly crowdRule?: boolean; readonly busy?: boolean; readonly crowdedRecently?: boolean } | undefined;
}

/**
 * The crowd rule: CROWD_COUNT (3) or more melee threats within CROWD_RANGE (4) and health below
 * CROWD_HEALTH (12) -> the crowd (nearest first), else []. Off when `combat.crowdRule` is false.
 * While a fight runs the fight applies it (it ends `crowded`; `crowdedRecently` for 5 ticks after,
 * so a kill job's next fight does not hide it); a fight that keeps going (started right after a
 * `crowded` end that brought no flight) is not overridden.
 */
export function crowded(h: CrowdHost, me: Vec3): EntityInfo[] {
  const hp = h.health();
  if (h.combat?.crowdRule === false || hp <= 0 || hp >= CROWD_HEALTH) return [];
  if (h.combat?.busy && !h.combat.crowdedRecently) return [];
  const c = crowdOf(h.d.world.entities.values(), h.mobs, me);
  if (c.length < CROWD_COUNT) return [];
  return c.sort((a, b) => dist(entityFeet(a), me) - dist(entityFeet(b), me));
}

/** The flee trigger from the crowd rule (`PveController.fleeReason`): the nearest of the crowd, if crowded. */
export function crowdThreat(h: CrowdHost, me: Vec3): EntityInfo | undefined {
  return crowded(h, me)[0];
}

export interface ReachCandidate {
  e: EntityInfo;
  /** Eye to box distance. */
  reach: number;
  hitUs: boolean;
  creeper: boolean;
}

/** The threats within `reach` of the eye (players, the dead and, with `noCreepers`, creepers left out). */
export function inReach(entities: Iterable<EntityInfo>, mobs: MobTracker, eye: Vec3, opts: { reach?: number; noCreepers?: boolean } = {}): ReachCandidate[] {
  const out: ReachCandidate[] = [];
  for (const e of entities) {
    if (!isThreat({ mobs }, e)) continue;
    const creeper = isCreeper(e.type);
    if (creeper && opts.noCreepers) continue;
    const r = reachDistance(eye, e);
    if (r > (opts.reach ?? REACH_NOW)) continue;
    out.push({ e, reach: r, hitUs: mobs.hitUsWithin(e.runtimeId, HIT_MEMORY_MS), creeper });
  }
  return out;
}

/**
 * The best target among candidates within reach: a mob that hit us in the last 10 s first, then a
 * creeper, then the nearest (eye to box); `current` gets RETARGET_BONUS. Every mob that hit us within
 * the 10 s ranks the same (not only the very last one): two zombies taking turns must not make the
 * bot alternate between them on every strike cycle, which spreads its damage and keeps both alive
 * longer (docs/pve.md "Targeting", measured). undefined = no candidate.
 */
export function pickInReach(cands: readonly ReachCandidate[], current: bigint | undefined): ReachCandidate | undefined {
  let best: { c: ReachCandidate; score: number } | undefined;
  for (const c of cands) {
    let score = c.reach;
    if (c.hitUs) score -= 100;
    else if (c.creeper) score -= 50;
    if (c.e.runtimeId === current) score -= RETARGET_BONUS;
    if (!best || score < best.score) best = { c, score };
  }
  return best?.c;
}

/** How long (ms) a mob is not picked again after a fight that ended `reason`; 0 = not ignored. */
export function ignoreMsAfter(reason: FightResult['reason']): number {
  switch (reason) {
    case 'killed':
    case 'creeper_avoided':
    case 'interrupted':
    case 'crowded': // Track AH: a flight follows; the mob is still a target afterwards
      return 0;
    case 'out_of_range':
      return 10_000;
    case 'unreachable':
      return PATH_IGNORE_MS; // Track AO: was 10 s (behind a wall the next guard tick picked it again)
    case 'took_cover':
      return 3_000;
    default:
      return 30_000;
  }
}

/** Apply the ignore rule for a finished guard fight (with the reason, Track AO). */
export function afterFight(h: Pick<TargetingHost, 'ignore'> & Partial<Pick<TargetingHost, 'ignoreWhy'>>, e: EntityInfo, r: Pick<FightResult, 'reason'>): void {
  const ms = ignoreMsAfter(r.reason);
  if (ms <= 0) return;
  const now = performance.now();
  h.ignore.set(e.runtimeId, now + ms);
  h.ignoreWhy?.set(e.runtimeId, { reason: `fight ${r.reason}`, at: now, type: e.type });
}
