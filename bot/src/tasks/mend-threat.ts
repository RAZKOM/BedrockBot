// Track K5 (ADR 0110, docs/survival.md "Mending (Track K5)"): which hostiles stop a Mending hold. A hold puts a piece
// that is no blade (an elytra, a spare tool) in the main hand for 0.3 to 3.5 s while the bot stands where it is, the
// armour on and the shield in the offhand. Before, any hostile within 16 stopped it; at a home by a lake and caves that is
// every hour (on the Realm 3 drowned within 16 at noon, 11 hostiles within 32, none able to reach the bot), so nothing
// was mended there. Now a hostile stops a hold only when it can hurt the bot during it, by the fight rules' own tests
// (skills/combat, unchanged):
//
// - it hit the bot in the last 10 s (MobTracker.hitUsWithin, HIT_MEMORY_MS);
// - it is within the reflex's strike reach (REFLEX_REACH + 1, eye to box) with a line on the bot: the reflex would strike
//   it with what the hand holds (combat.ts swapHandOk takes the blade from the hotbar only for a block or a digging tool,
//   so a held elytra strikes as a fist);
// - a creeper with its fuse lit within 8;
// - a shooter (an archer, a witch, a blaze, a ghast, a breeze, a shulker, an evoker; a drowned with a trident) within
//   ARCHER_RANGE (16, the shield's watch) with a line of sight to the bot's eye (targeting.ts lineOfSight);
// - a flying mob within its walk bound (below) with a line of sight;
// - any other mob whose walking path to the bot (pathReach.ts, the guard's probe: the bot's own walk, no digging, no
//   placing) is no longer than what it covers in the hold (reflex.ts mobSpeed x the hold's ticks) plus its reach
//   (mobReach) plus one block: a zombie 11.2, a spider 14.6, a creeper 11, an enderman 24.4 path blocks for 70 ticks. A
//   mob farther than that in a straight line cannot come in time; one whose probe found no path (a wall, a lake behind a
//   wall, a pit) cannot come at all. A cached path counts MOVED (3) blocks shorter than it was found (the mob may have
//   come that much nearer since), never shorter than the straight line; while a new probe runs, a mob that had a path
//   counts by its straight distance and one that had none still has none (the drowned in a lake move all the time and are
//   probed again and again). A mob never probed yet counts as a threat within PENDING_NEAR (6) and not beyond.
//
// Where the body walks away from where it stands (the walk to a kill's orbs, the `!mend` mine source) the old rule stays:
// no hostile within MEND_THREAT (16), whatever its way (nearHostile).
import { bareType, entityFeet, isArcher, isCreeper, isFlying, reachDistance, type MobTracker } from '../skills/combat/hostiles.ts';
import { MOVED, type PathVerdict } from '../skills/combat/pathReach.ts';
import { mobReach, mobSpeed, REFLEX_REACH } from '../skills/combat/reflex.ts';
import { ARCHER_RANGE } from '../skills/combat/shield.ts';
import { HIT_MEMORY_MS, isThreat, lineOfSight, type GridLike } from '../skills/combat/targeting.ts';
import type { EntityInfo, Vec3 } from '../world/types.ts';

/** Eye height of the bot's body. */
const EYE = 1.62;
/** Mobs farther than this are not looked at (the server sends entities to about this far in a loaded world). */
export const HOLD_SCAN = 32;
/** A mob whose path probe has not answered yet counts as a threat this near (blocks, feet to feet). */
export const PENDING_NEAR = 6;
/** A lit creeper this near stops a hold. */
export const LIT_CREEPER = 8;
/** Mobs that hurt from afar (besides isArcher's archers and a drowned with a trident). */
export const SHOOTERS: ReadonlySet<string> = new Set(['witch', 'blaze', 'ghast', 'breeze', 'shulker', 'evoker', 'evocation_illager']);

export interface HoldThreatDeps {
  entities(): ReadonlyMap<bigint, EntityInfo>;
  /** The fight's mob tracker (hits, targets, fuses, held items). */
  mobs: MobTracker;
  /** The world (isThreat's gold rule for piglins). */
  world?: object;
  /** The planner's grid (lines of sight); undefined: every line counts as clear. */
  grid(): GridLike | undefined;
  /** The guard's path probes (PveController.pathReach); undefined: every walker within its bound counts. */
  path(): { lookup(e: EntityInfo, me: Vec3): PathVerdict | 'pending' | 'none'; peek(rid: bigint): PathVerdict | undefined } | undefined;
}

/** What stops a hold: the line for the log and the replies, and whether it is only a probe still running. */
export interface HoldThreat {
  why: string;
  /** Only a path probe that has not answered (prepare waits a little for it). */
  pending: boolean;
  e: EntityInfo;
}

/** The path blocks a walking mob covers in `ticks` and still strikes from (speed x ticks + its reach + 1). */
export function walkBound(type: string, baby: boolean, ticks: number): number {
  return mobSpeed(type, baby) * ticks + mobReach(type) + 1;
}

const name = (e: EntityInfo): string => bareType(e.type);
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * The first hostile (nearest first) that can hurt the bot standing at `me` within `ticks` (see the file comment), or
 * undefined. Every mob within the bound gets its probe asked for (one runs at a time; the answers are cached).
 */
export function holdThreat(d: HoldThreatDeps, me: Vec3, ticks: number): HoldThreat | undefined {
  const eye = { x: me.x, y: me.y + EYE, z: me.z };
  const grid = d.grid();
  const host = d.world ? { mobs: d.mobs, d: { world: d.world } } : { mobs: d.mobs };
  const near: { e: EntityInfo; r: number }[] = [];
  for (const e of d.entities().values()) {
    if (!isThreat(host, e) || d.mobs.get(e.runtimeId)?.dead) continue;
    const r = dist(entityFeet(e), me);
    if (r <= HOLD_SCAN) near.push({ e, r });
  }
  near.sort((a, b) => a.r - b.r);
  const seen = (e: EntityInfo): boolean => !grid || lineOfSight(grid, eye, e);
  let pending: HoldThreat | undefined;
  for (const { e, r } of near) {
    const at = `a ${name(e)} ${r.toFixed(0)} blocks off`;
    const st = d.mobs.get(e.runtimeId);
    if (d.mobs.hitUsWithin(e.runtimeId, HIT_MEMORY_MS)) return { why: `${at} hit me in the last ${HIT_MEMORY_MS / 1000} s`, pending: false, e };
    if (reachDistance(eye, e) <= REFLEX_REACH + 1 && seen(e)) return { why: `${at} in strike reach`, pending: false, e };
    if (isCreeper(e.type) && st?.ignited && r <= LIT_CREEPER) return { why: `${at} with its fuse lit`, pending: false, e };
    if ((isArcher(e, d.mobs) || SHOOTERS.has(name(e))) && r <= ARCHER_RANGE && seen(e)) return { why: `${at} with a line on me`, pending: false, e };
    const bound = walkBound(e.type, st?.baby === true, ticks);
    if (r > bound) continue;
    if (isFlying(e.type)) {
      if (seen(e)) return { why: `${at} flying, with a line on me`, pending: false, e };
      continue;
    }
    const pr = d.path();
    if (!pr) return { why: `${at} (no way to tell its way to me)`, pending: false, e };
    let v = pr.lookup(e, me);
    if (v === 'none') return { why: `${at} (no way to tell its way to me)`, pending: false, e };
    // a verdict is made for where the mob stood (up to MOVED blocks ago, or longer for one whose new probe still runs):
    // a path counts as no longer than the path then less MOVED, never shorter than the straight line; no path stays no
    // path until the new probe answers (a wall does not move)
    if (v === 'pending') {
      const old = pr.peek(e.runtimeId);
      if (old?.ok) v = { ok: true, blocks: r };
      else if (old) v = old;
      else {
        if (r <= PENDING_NEAR) pending ??= { why: `${at}, its way to me not known yet`, pending: true, e };
        continue;
      }
    }
    const blocks = v.ok ? Math.max(r, v.blocks - MOVED) : Infinity;
    if (blocks <= bound) return { why: `${at} with a clear way to me (${v.ok ? v.blocks.toFixed(0) : '?'} path blocks)`, pending: false, e };
  }
  return pending;
}

/**
 * Track K6 (docs/survival.md "The walk to a kill's orbs"): the walk to orbs that lie (at most ORB_NEAR off, no digging,
 * 5 s at most) with hostiles within MEND_THREAT, by the hold rule's own tests over the hold and the walk together (`ticks`):
 * a hostile within `r` of the bot or of the orb stops it when it hit the bot, is in strike reach, is a lit creeper, a shooter
 * or a flying mob with a line on the bot or on the orb, or a walker with a path to the bot within its bound or whose way is
 * not known (a probe still running, `pending`; no probes at all). A walker whose probe found no path (a lake behind a wall, a
 * pit, a closed room) cannot come to the orb either: the bot walks there without digging, so a way from the mob to the orb
 * would be a way to the bot. The path is the guard's probe from where the bot stands, so a mob that can drop down to the
 * bot but not be walked to counts as no path (as in the hold rule). Undefined: every hostile within `r` is held off.
 */
export function walkThreat(d: HoldThreatDeps, me: Vec3, to: Vec3, ticks: number, r: number): HoldThreat | undefined {
  const eye = { x: me.x, y: me.y + EYE, z: me.z };
  const eyeTo = { x: to.x, y: to.y + EYE, z: to.z };
  const grid = d.grid();
  const host = d.world ? { mobs: d.mobs, d: { world: d.world } } : { mobs: d.mobs };
  const near: { e: EntityInfo; r: number }[] = [];
  for (const e of d.entities().values()) {
    if (!isThreat(host, e) || d.mobs.get(e.runtimeId)?.dead) continue;
    const f = entityFeet(e);
    const rr = Math.min(dist(f, me), dist(f, to));
    if (rr <= r) near.push({ e, r: dist(f, me) });
  }
  near.sort((a, b) => a.r - b.r);
  const seen = (e: EntityInfo): boolean => !grid || lineOfSight(grid, eye, e) || lineOfSight(grid, eyeTo, e);
  let pending: HoldThreat | undefined;
  for (const { e, r: dd } of near) {
    const at = `a ${name(e)} ${dd.toFixed(0)} blocks off`;
    const st = d.mobs.get(e.runtimeId);
    if (d.mobs.hitUsWithin(e.runtimeId, HIT_MEMORY_MS)) return { why: `${at} hit me in the last ${HIT_MEMORY_MS / 1000} s`, pending: false, e };
    if (Math.min(reachDistance(eye, e), reachDistance(eyeTo, e)) <= REFLEX_REACH + 1 && seen(e)) return { why: `${at} in strike reach of me or the orbs`, pending: false, e };
    if (isCreeper(e.type) && st?.ignited && dd <= LIT_CREEPER) return { why: `${at} with its fuse lit`, pending: false, e };
    if (isArcher(e, d.mobs) || SHOOTERS.has(name(e))) {
      if (seen(e)) return { why: `${at} with a line on me or the orbs`, pending: false, e };
      continue;
    }
    if (isFlying(e.type)) {
      if (seen(e)) return { why: `${at} flying, with a line on me or the orbs`, pending: false, e };
      continue;
    }
    const pr = d.path();
    if (!pr) return { why: `${at} (no way to tell its way to me)`, pending: false, e };
    const v = pr.lookup(e, me);
    if (v === 'none') return { why: `${at} (no way to tell its way to me)`, pending: false, e };
    if (v === 'pending') {
      // (a probe running: a mob that had no path keeps none, as in the hold rule; one that had a path or was never probed waits)
      const old = pr.peek(e.runtimeId);
      if (old && !old.ok) continue;
      pending ??= { why: `${at}, its way to me not known yet`, pending: true, e };
      continue;
    }
    if (v.ok && Math.max(dd, v.blocks - MOVED) <= walkBound(e.type, st?.baby === true, ticks)) return { why: `${at} with a clear way to me (${v.blocks.toFixed(0)} path blocks)`, pending: false, e };
  }
  return pending;
}

/** The old rule, kept where the body walks away: a hostile within `r` (feet to feet), whatever its way; its line. */
export function nearHostile(d: Pick<HoldThreatDeps, 'entities' | 'mobs' | 'world'>, me: Vec3, r: number): string | undefined {
  const host = d.world ? { mobs: d.mobs, d: { world: d.world } } : { mobs: d.mobs };
  let best: { e: EntityInfo; r: number } | undefined;
  for (const e of d.entities().values()) {
    if (!isThreat(host, e) || d.mobs.get(e.runtimeId)?.dead) continue;
    const dd = dist(entityFeet(e), me);
    if (dd <= r && (!best || dd < best.r)) best = { e, r: dd };
  }
  return best ? `a ${name(best.e)} ${best.r.toFixed(0)} blocks off (within ${r})` : undefined;
}
