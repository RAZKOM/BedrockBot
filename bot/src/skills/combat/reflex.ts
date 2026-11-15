// The mob reflex (Track M1, docs/pve.md "Never die to common mobs (Track M1)", ADR 0079): an always-on
// layer under every activity. On every tick it strikes the hostiles within reach whose hurt time is over,
// the one that will reach the bot soonest first, without turning and without touching the movement keys,
// so a walk, a dig, a bite or a fight goes on as it was.
//
// What it stands on (measured on BDS 1.26.60 with test/e2e/pve-rules.test.ts, docs/pve.md):
// - an attack lands whatever way the bot looks (0, 90 and 180 degrees off, also while walking away);
// - the knockback goes along the line from the bot to the mob, not along the bot's view, so a strike on a
//   mob behind a bot that walks away pushes it farther away;
// - attacks land up to an eye-to-box distance well beyond the 3.0 the fights strike at (REFLEX_REACH),
//   while a zombie hits from 1.2 to 1.7 blocks (feet to feet): struck at reach every 10 ticks, a single
//   melee mob is pushed back faster than it walks in;
// - the server takes one hit per mob per hurt time (10 ticks) and several mobs in the same tick;
// - a strike while the shield is raised lowers it: with a skeleton shooting at a bot sneaking behind a shield, 8 of 8 arrows
//   were blocked with no strikes, and 9 of 14 hurt with a strike every 4 to 20 ticks, each within 1 to 13 ticks of a strike
//   (the blocked ones came 17 ticks or more after one). So with the shield up the reflex strikes only what costs more than
//   the lowered shield: a lit creeper within its blast (CREEPER_STRIKE_RANGE) and a melee mob about to land a hit from
//   outside the shield's arc (the shield blocks 0 to 90 degrees off the view, measured: one in front is blocked anyway).
//
// Who it never strikes: players (also under any name), passive mobs, items, the warden and the creaking
// (striking them only makes it worse), iron golems (deadly; running is the answer), and neutral mobs
// unless they attacked: the server says they target the bot (`target_eid`) AND the bot's hit guess blamed
// them within 10 s (either alone is not enough: the guess can blame a wolf standing next to the real
// attacker, and an enderman targets a player that only looked at it). A dead mob, one out of sight (a
// solid block between), one still in its hurt time.
import type { Logger } from '../../log.ts';
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import { EYE_HEIGHT } from './combat.ts';
import { angleDiff, yawTowards } from '../nav/follower.ts';
import { bareType, classify, entityFeet, isCreeper, isPlayerEntity, RANGED_TYPES, reachDistance, type MobTracker } from './hostiles.ts';
import { isThreat, lineOfSight, type GridLike } from './targeting.ts';

/** Eye-to-box distance the reflex strikes at (attacks landed on the server up to 4.2; the fights strike at 3.0). */
export const REFLEX_REACH = 3.9;
/** A mob's hurt time: the server takes one hit per mob in this many ticks. */
export const HURT_TICKS = 10;
/**
 * A hurt animation this recent (ms) means the mob is still in its hurt time from another strike (a fight's,
 * an arrow): 10 ticks less the time the animation takes to arrive; our own strikes are timed by HURT_TICKS.
 */
export const HURT_MS = 400;
/** At most this many strikes in one tick (the server took 3 in one tick). */
export const MAX_PER_TICK = 3;
/** A strike without a hurt animation within this many ticks did not land. */
const LAND_TICKS = 8;
/** Ticks a strike lowers a raised shield for (measured: hurt 1 to 13 ticks after a strike, blocked from 17). */
export const SHIELD_DOWN_TICKS = 16;
/** With the shield up, a lit creeper is still struck within this distance (feet to feet): its blast hurts through the shield. */
export const CREEPER_STRIKE_RANGE = 4.5;
/** The shield's arc: a melee hit from within this many degrees off the view is blocked (measured 0 to 90). */
export const SHIELD_ARC = 90;
/** With the shield up, a melee mob outside the arc is struck when it can hit within this many ticks. */
const GUARDED_MELEE_ETA = 2;

/** A mob not struck for this long (ms) starts a new engagement (one log line). */
const ENGAGE_MS = 5000;

/** A neutral mob is struck only within this long (ms) of a hit the guess blamed on it (and while it targets the bot). */
export const NEUTRAL_HIT_MS = 10_000;

/** Never struck by the reflex, whatever they do. */
export const REFLEX_NEVER: ReadonlySet<string> = new Set(['warden', 'creaking', 'iron_golem', 'snow_golem', 'copper_golem', 'villager', 'villager_v2', 'wandering_trader', 'allay', 'ender_dragon', 'wither']);

/** Where a mob's melee hits come from (feet to feet, blocks; a zombie measured 1.2 to 1.7). */
export function mobReach(type: string): number {
  switch (bareType(type)) {
    case 'spider':
      return 2.4;
    case 'cave_spider':
      return 1.9;
    case 'enderman':
    case 'ravager':
    case 'hoglin':
    case 'zoglin':
      return 2.4;
    case 'slime':
    case 'magma_cube':
      return 2.2;
    case 'creeper':
      return 3.0; // the fuse lights within about 3 blocks
    default:
      return 1.8;
  }
}

/** How fast a mob closes in when it chases (blocks a tick, rough). */
export function mobSpeed(type: string, baby = false): number {
  if (baby) return 0.2;
  switch (bareType(type)) {
    case 'phantom':
    case 'vex':
      return 0.4;
    case 'enderman':
      return 0.3;
    case 'spider':
    case 'cave_spider':
      return 0.16;
    case 'creeper':
      return 0.1;
    case 'slime':
    case 'magma_cube':
      return 0.15;
    default:
      return 0.12;
  }
}

/** May the reflex strike this entity at all (not where it is)? See the file comment. */
export function reflexTarget(e: EntityInfo, mobs: MobTracker, world?: object): boolean {
  if (isPlayerEntity(e)) return false;
  const t = bareType(e.type);
  if (REFLEX_NEVER.has(t)) return false;
  if (mobs.get(e.runtimeId)?.dead) return false;
  const cls = classify(e.type);
  if (cls === 'hostile') return true;
  if (cls !== 'neutral' && cls !== 'other') return false;
  // a neutral mob only once it attacked: it targets the bot (the server's word) and it hit the bot (the guess),
  // never a piglin while the bot wears gold (isThreat's rule)
  return mobs.targetsUs(e.runtimeId) && mobs.hitUsWithin(e.runtimeId, NEUTRAL_HIT_MS) && isThreat(world ? { mobs, d: { world } } : { mobs }, e);
}

export interface ReflexCandidate {
  e: EntityInfo;
  /** Eye to box. */
  reach: number;
  /** Ticks until it can hit the bot (0 = it can now); lower goes first. */
  eta: number;
  /** The sort key (eta with the bonuses). */
  score: number;
}

export interface ReflexInput {
  entities: Iterable<EntityInfo>;
  mobs: MobTracker;
  me: Vec3;
  grid?: GridLike | undefined;
  world?: object;
  /** Tick of our last strike on each mob. */
  struck: ReadonlyMap<bigint, number>;
  tick: number;
  reach?: number;
  /** Not now: the strikes would hurt the current work: only mobs this close in ticks. */
  maxEta?: number;
  /**
   * The shield is raised and the bot looks along `yaw` (degrees): a strike lowers it (SHIELD_DOWN_TICKS), so only a lit
   * creeper within CREEPER_STRIKE_RANGE and a melee mob about to hit from outside the shield's arc are struck.
   */
  guarded?: { yaw: number };
  /** A fight strikes this mob itself (its target): left to it while it is within the fight's reach. */
  skip?: bigint | undefined;
}

/**
 * The mobs to strike this tick, in order (the one that will reach the bot soonest first): reflex targets
 * within reach and in sight whose hurt time is over. A lit creeper first, then a mob that hit us in the
 * last 2 s, then by the ticks until it can hit (its distance less its own reach, over its speed).
 */
export function reflexPicks(i: ReflexInput): ReflexCandidate[] {
  const eye = { x: i.me.x, y: i.me.y + EYE_HEIGHT, z: i.me.z };
  const reach = i.reach ?? REFLEX_REACH;
  const out: ReflexCandidate[] = [];
  for (const e of i.entities) {
    if (e.runtimeId === i.skip) continue;
    if (!reflexTarget(e, i.mobs, i.world)) continue;
    const r = reachDistance(eye, e);
    if (r > reach) continue;
    const last = i.struck.get(e.runtimeId);
    if (last !== undefined && i.tick - last < HURT_TICKS) continue;
    const st = i.mobs.get(e.runtimeId);
    if (i.mobs.inHurtTime(e.runtimeId, HURT_MS)) continue;
    if (i.grid && !lineOfSight(i.grid, eye, e)) continue;
    const f = entityFeet(e);
    const d = Math.hypot(f.x - i.me.x, f.y - i.me.y, f.z - i.me.z);
    const eta = Math.max(0, d - mobReach(e.type)) / mobSpeed(e.type, st?.baby === true);
    if (i.maxEta !== undefined && eta > i.maxEta) continue;
    if (i.guarded && !worthTheShield(e, st?.ignited === true, d, eta, i.me, i.guarded.yaw)) continue;
    let score = eta;
    if (isCreeper(e.type) && st?.ignited) score -= 1000;
    else if (i.mobs.hitUsWithin(e.runtimeId, 2000)) score -= 100;
    out.push({ e, reach: r, eta, score });
  }
  return out.sort((a, b) => a.score - b.score);
}

/**
 * With the shield raised: is a strike on this mob worth the lowered shield (see the file comment)? A lit creeper within
 * CREEPER_STRIKE_RANGE, or a melee mob (not a ranged one) that can hit within GUARDED_MELEE_ETA ticks from outside the arc.
 */
export function worthTheShield(e: EntityInfo, ignited: boolean, d: number, eta: number, me: Vec3, yaw: number): boolean {
  if (isCreeper(e.type)) return ignited && d <= CREEPER_STRIKE_RANGE;
  if (RANGED_TYPES.has(bareType(e.type))) return false;
  if (eta > GUARDED_MELEE_ETA) return false;
  const f = entityFeet(e);
  if (Math.hypot(f.x - me.x, f.z - me.z) < 1e-3) return true;
  return Math.abs(angleDiff(yaw, yawTowards(f.x - me.x, f.z - me.z))) > SHIELD_ARC;
}

/** What the reflex drives (the PvE controller wires it). */
export interface ReflexDeps {
  loop: {
    readonly state: { readonly ready: boolean; readonly pos: Vec3 };
    readonly command: { readonly sneak?: boolean; readonly yaw?: number };
    onBeforeStep(fn: () => void): () => void;
  };
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  mobs: MobTracker;
  /** One strike without turning (CombatController.attack); false when refused. */
  attack: (rid: bigint, opts: { reach: number }) => boolean;
  /** On (the `mobReflex` setting) and able (alive, spawned, not flying). */
  enabled: () => boolean;
  /** Track M3: the eye-to-box distance it strikes at now (default REFLEX_REACH; farther while a flight comes down onto its landing). */
  reach?: () => number;
  grid?: () => GridLike | undefined;
  world?: object;
  /** The shield is raised (sneaking with a shield in the offhand): only strike what is worth lowering it (worthTheShield). */
  shieldUp?: () => boolean;
  /** The running fight's target and whether it is within the fight's own reach (the fight strikes it then). */
  fightTarget?: () => bigint | undefined;
  log?: Logger;
  metrics?: { inc(name: string, by?: number): void };
}

export interface ReflexTotals {
  /** Strikes sent. */
  hits: number;
  /** Strikes the mob showed a hurt for. */
  landed: number;
  /** Mobs that died within a second of a reflex strike. */
  kills: number;
  /** Strikes by mob type. */
  byType: Record<string, number>;
}

/** The reflex itself: one per bot, ticking from the input loop's before-step hook. */
export class Reflex {
  readonly totals: ReflexTotals = { hits: 0, landed: 0, kills: 0, byType: {} };
  private readonly d: ReflexDeps;
  private readonly struck = new Map<bigint, number>();
  private readonly engagedAt = new Map<bigint, number>();
  private readonly strikes = new Map<bigint, number>();
  private pending: { rid: bigint; t: number; hurts: number; type: string }[] = [];
  private t = 0;
  private readonly off: () => void;

  constructor(d: ReflexDeps) {
    this.d = d;
    this.off = d.loop.onBeforeStep(() => this.tick());
  }

  dispose(): void {
    this.off();
  }

  /** One tick (exposed for tests). */
  tick(): void {
    this.t++;
    this.settle();
    const s = this.d.loop.state;
    if (!s.ready || !this.d.enabled()) return;
    const now = performance.now();
    const reach = this.d.reach?.() ?? REFLEX_REACH;
    const picks = reflexPicks({
      entities: this.d.entities().values(),
      mobs: this.d.mobs,
      me: s.pos,
      reach,
      grid: this.d.grid?.(),
      world: this.d.world,
      struck: this.struck,
      tick: this.t,
      ...(this.d.shieldUp?.() ? { guarded: { yaw: this.d.loop.command.yaw ?? 0 } } : {}),
      skip: this.d.fightTarget?.(),
    });
    let n = 0;
    for (const c of picks) {
      if (n >= MAX_PER_TICK) break;
      if (!this.d.attack(c.e.runtimeId, { reach: reach + 0.05 })) continue;
      n++;
      const rid = c.e.runtimeId;
      const type = bareType(c.e.type);
      this.struck.set(rid, this.t);
      this.totals.hits++;
      this.totals.byType[type] = (this.totals.byType[type] ?? 0) + 1;
      this.d.metrics?.inc('pve.reflex.hits');
      this.strikes.set(rid, (this.strikes.get(rid) ?? 0) + 1);
      this.pending.push({ rid, t: this.t, hurts: this.d.mobs.get(rid)?.hurts ?? 0, type });
      const last = this.engagedAt.get(rid);
      if (last === undefined || now - last > ENGAGE_MS) {
        this.strikes.set(rid, 1);
        this.d.log?.info(`reflex: ${type} #${rid} in reach (${c.reach.toFixed(1)}, can hit us in ${c.eta < 0.5 ? 'now' : `${Math.round(c.eta)} ticks`}${picks.length > 1 ? `, ${picks.length} ready` : ''}): striking`);
      }
      this.engagedAt.set(rid, now);
    }
  }

  /** Count the strikes that landed (a hurt animation since) and the kills; forget gone mobs. */
  private settle(): void {
    if (this.pending.length === 0 && this.struck.size < 64) return;
    const ents = this.d.entities();
    const keep: typeof this.pending = [];
    for (const p of this.pending) {
      const st = this.d.mobs.get(p.rid);
      if (st && st.hurts > p.hurts) {
        this.totals.landed++;
        if (st.dead || (st.health !== undefined && st.health <= 0)) this.killed(p.rid, p.type);
        continue;
      }
      if (st?.dead || !ents.has(p.rid)) {
        if (this.t - p.t <= LAND_TICKS + 12) this.killed(p.rid, p.type);
        continue;
      }
      if (this.t - p.t <= LAND_TICKS) keep.push(p);
    }
    this.pending = keep;
    for (const rid of [...this.struck.keys()]) {
      if (!ents.has(rid) || this.t - (this.struck.get(rid) ?? 0) > 1200) {
        this.struck.delete(rid);
        this.engagedAt.delete(rid);
        this.strikes.delete(rid);
      }
    }
  }

  private killed(rid: bigint, type: string): void {
    if (!this.strikes.has(rid)) return;
    this.totals.kills++;
    this.d.metrics?.inc('pve.reflex.kills');
    this.d.log?.info(`reflex: ${type} #${rid} down (${this.strikes.get(rid)} strike(s) since it came in reach)`);
    this.strikes.delete(rid);
    this.engagedAt.delete(rid);
  }
}
