// PvE behaviours on the AFK task (PLAN.md tasks 7.4 to 7.6, docs/pve.md): guard, flee, follow, come,
// kill, and a resumable goto. PvE ONLY: nothing here ever targets a player (the combat skill refuses
// players itself, and every target list below skips them).
//
// Since wave 6 (PLAN.md 7.8, Track Q) every behaviour is a process of the ProcessManager
// (tasks/process/manager.ts, docs/processes.md), which gives control to one of them at a time:
//   flee (100) > guard fighting in place (85) > night shelter (80) > guard fight (60)
//   > the owner's command: goto / follow / come / kill / gather (40, newest on top) > home return (20)
// A pre-empted process is paused and resumed when the higher one ends (follow starts again, the goto
// is planned again, a kill job looks for its next target). The settings (guardRadius, fleeHealth,
// followDistance, sprint, allowBreak, ...) are read live from RuntimeSettings (config/settings.ts).
//
// Rules (evaluated every tick by the manager through the processes' wants()):
// - flee (v2, wave 7 Track W, docs/pve.md "Flee"): health below `fleeHealth` (default 8) with a
//   hostile alive within 16 blocks, or a creeper within 6 with health below 10 -> first the runAway
//   goal to 12 blocks from every threat; then the shelter (else home) only when no threat is between
//   (its bearing more than 60 degrees off the home bearing, or it is farther than home); otherwise on
//   running away (up to 40 blocks), re-planned every 2 s. While fleeing and 8 blocks clear of every
//   hostile it eats below health 10. While the health stays low the bot only defends in place. Not
//   while night safety is already walking to the shelter (same place; interrupting would count as a
//   failed retreat). A kill job does not survive a flight.
// - trip readiness (wave 7 Track W, tasks/process/readiness.ts): come / follow / kill / a walk of more
//   than 16 blocks first eats and puts on armour when food or health is below 14.
// - guard (when on): the hostile closest to the bot (or the one that hit it in the last 10 s, or one
//   that targets it) within `guardRadius` of the home point (of the bot when no home is set or while
//   a command runs) is fought. Neutral mobs only when they hit or target the bot. Players never. Not
//   while a kill job is the active process (it is fighting already). Track AO: a mob not within reach
//   needs a probe path of at most `guardReach` blocks (else ignored 30 s); during a user walk only mobs
//   within reach or melee threats within 6 path blocks (`guardWhileWalking`; docs/pve.md).
// - night: while night safety wants the shelter, inside it the bot only defends in place (85, above
//   the night process); on the way there guard does not interrupt (60 < 80).
// - after a guard fight (not in place) the drops within 8 blocks are picked up; with no command
//   running and a home set, the bot walks home (the home-return process, dropped by any new command).
import type { Metrics } from '../connection/metrics.ts';
import { RuntimeSettings } from '../config/settings.ts';
import { silentLogger, type Logger } from '../log.ts';
import { events } from '../events/bus.ts'; // decision 0059: combat.flee
import { bladeScore, CombatController, strikeDamage, type CombatLoop, type CombatMover, type FightOptions, type FightResult } from '../skills/combat/combat.ts';
import { ARCHER_TYPES, bareType, classify, entityFeet, isPlayerEntity, MobTracker, poisonLeft, RANGED_TYPES, typeMatches } from '../skills/combat/hostiles.ts';
import * as targeting from '../skills/combat/targeting.ts'; // Track V: reachability-aware targeting, creeper rank
import { PathReach, probeNavOf } from '../skills/combat/pathReach.ts'; // Track AO: path-reachable guard targets
import { Reflex, REFLEX_REACH } from '../skills/combat/reflex.ts'; // Track M1: the always-on strike layer
import { dodgeStep, POTION_STEP_TICKS, potionSideStep, type DodgeShooter } from '../skills/combat/dodge.ts'; // Track M1 round 2: across the line of fire
import { canSealHere, seal, sealCells, openSide, type SealDeps } from '../skills/survival/seal.ts'; // Track M1: the last floor
import { clickableName } from '../skills/place/place.ts'; // Track E10: the seal's faces
import { FollowController, type FollowLoop, type FollowTarget } from '../skills/follow/follow.ts';
import type { Goal, NavGoal } from '../skills/nav/goals.ts';
import type { GotoOptions, SkillResult } from '../skills/types.ts';
import { headInWater } from '../skills/survival/surface.ts'; // Track BF
import { chooseFood } from '../skills/survival/eat.ts'; // Track M1: the eat floor
import { EAT_BEFORE_SPRINT_LOST } from '../skills/survival/index.ts'; // Track M2
import { BladeProcess, type BladeSmith } from './process/blade.ts'; // Track M9
import { RiseProcess, type RiseView } from './creeper-rise.ts'; // Track E12 (`creeperRise`)
import { throwawayCount } from '../skills/mine/wire.ts'; // Track E12: the rise's blocks
import { ArchersProcess, ARCHERS_MIN, ARCHERS_RANGE, type ArcherSeen, type ArchersView } from './work-archers.ts'; // Track E13 (`workArchers`)
import { Hotbar } from '../world/hotbar.ts';
import type { Inventory } from '../world/inventory.ts';
import { armourScore, WINDOW_ARMOR } from '../skills/survival/armour.ts';
import type { EntityInfo, PacketSource, Vec3 } from '../world/types.ts';
import { etaFor, GotoProcess, navRemaining, settingsMover, type GotoProcessOptions, type ProcessMover } from './process/goto.ts';
import { BaseProcess, PRIORITY, ProcessManager, type Process, type ProcessStatus, type StopReason } from './process/manager.ts';
import { checkTrip, longTrip, needsPrep, prepareTrip, type PrepPhase, type TripCheck, type TripKit, type TripStock } from './process/readiness.ts'; // Track W
import { PlayerLocator } from './process/locator.ts'; // Track W

export interface GuardSettings {
  on: boolean;
  radius: number;
}

export interface PveOptions {
  guard?: Partial<GuardSettings>;
  /** Flee below this health. Default 8. */
  fleeHealth?: number;
  /** Pick up drops within this radius after a kill. Default 8. */
  collectRadius?: number;
}

export interface PveNight {
  wantsShelter(): boolean;
  inside(): boolean;
  readonly state: string;
  /** NightSafety.status() (`timeOfDay` for the trip rules; Track W). */
  status?(): Record<string, unknown>;
}

/** The world model as PvE reads it (`World` satisfies it). */
export interface PveWorld {
  readonly entities: ReadonlyMap<bigint, EntityInfo>;
  readonly inventory: Inventory;
  readonly self: { readonly runtimeId: bigint; readonly health: number; readonly food?: number };
  /** Track BF: drowning attribution (the eyes in water); optional. */
  blockAt?(p: Vec3): { name: string } | undefined;
}

/** The InputLoop as PvE drives it (`InputLoop` satisfies it). */
export type PveLoop = CombatLoop & FollowLoop & { waitTicks?(n: number): Promise<void> };

/** BotSkills as PvE uses it (`BotSkills` satisfies it). */
export interface PveSkills extends CombatMover {
  collect(radius: number, timeoutTicks: number): Promise<unknown>;
  /** Track M1: the seal-in floor places and digs (BotSkills has both). */
  place?(p: Vec3, opts?: { item?: string | string[]; look?: boolean; jump?: boolean; timeoutTicks?: number }): Promise<{ ok: boolean; reason?: string }>;
  dig?(p: Vec3): Promise<{ ok: boolean; reason?: string }>;
}

export interface PveDeps {
  source: PacketSource;
  world: PveWorld;
  loop: PveLoop;
  skills: PveSkills;
  home: () => Vec3 | undefined;
  shelter: () => Vec3 | undefined;
  night?: PveNight;
  /** Dead or not spawned: do nothing. */
  inactive: () => boolean;
  log?: Logger;
  metrics?: Metrics;
  options?: PveOptions;
  /** The task's process manager (Track Q). Default: an own one driven by the loop. */
  processes?: ProcessManager;
  /** Live settings (Track Q). Default: in memory, with `options` applied as start-up values. */
  settings?: RuntimeSettings;
}

export interface KillResult {
  ok: boolean;
  type: string;
  killed: number;
  want: number;
  reason: 'done' | 'none_left' | 'interrupted' | (string & {});
  fights: FightResult[];
}

export const DEFAULT_GUARD_RADIUS = 16;
const CHASE_EXTRA = 16;
const KILL_SEARCH = 32;
const FLEE_SCAN = 16;
// ---- flee v2 (Track W) ----
/** First leg: at least this far from every threat. */
export const FLEE_AWAY = 12;
/** When home is blocked (or there is none): run on up to this far. */
export const FLEE_FAR = 40;
/** Re-plan the run-away every 2 s. */
export const FLEE_REPLAN_MS = 2000;
/** Home is clear when every threat's bearing is more than this off the home bearing (or it is farther than home). */
export const FLEE_HOME_ANGLE = 60;
/** Eat while fleeing below this health ... */
export const FLEE_EAT_BELOW = 10;
/** ... when every hostile is at least this far. */
export const FLEE_EAT_CLEAR = 8;
/** A creeper this close with health below FLEE_CREEPER_HEALTH: flee whatever fleeHealth says. */
export const FLEE_CREEPER_RANGE = 8; // merge: same radius as targeting.wantsFlee (Track V, CREEPER_AVOID_RANGE)
export const FLEE_CREEPER_HEALTH = 10;
/**
 * Track E7 (`creeperReach`, docs/pve.md "A creeper in reach"): a creeper's blast hurts within this of the feet (3D):
 * measured 8.6 at 4 blocks and 2.0 at 5.5, no armour.
 */
export const CREEPER_BLAST_REACH = 6;
/**
 * Track E7: a fuse seen lit this many ticks, the creeper within CREEPER_BLAST_REACH: the body leaves. The fuse runs 31
 * ticks (every measured case). In the tunnel replica the reflex's strikes cut the fuse 9 times of 9 and the longest it
 * burned was 21 to 23 ticks: a strike that comes late leaves no time. From 12 the body has 19 ticks to run.
 */
export const CREEPER_LIT_BACKOFF = 12;
/**
 * Track E7: strikes that keep a creeper off: with these or fewer needed to kill it (a stone pickaxe or better on a full
 * creeper: 5), the reflex's strikes from reach killed it in 13 of 13 replica runs, no blast. A fist or a block (20) does
 * not keep it off (Track M1: 2 strikes, lit, 4.1 damage).
 */
export const CREEPER_STRIKES_MAX = 5;
/** Track E7: with strikes that do not keep it off, a creeper this close (feet, 3D) starts the back-off. */
export const CREEPER_BACKOFF_RANGE = 5;

/** Track E7: the strikes needed for this creeper (health unknown or 0: a full 20) are few enough to keep it off. */
export function creeperStrikesEnough(health: number | undefined, damage: number): boolean {
  if (!(damage > 0)) return false;
  const hp = health !== undefined && health > 0 ? health : 20;
  return Math.ceil(hp / damage - 1e-9) <= CREEPER_STRIKES_MAX;
}
/** A hard trigger with the threat this close ignores the cooldown after a flight (immediate danger). */
export const FLEE_URGENT = 6;
/** After a flight, keep away from hostiles until the health is back to fleeHealth + this (for up to FLEE_RECOVER_MS). */
export const FLEE_RECOVER = 6;
const FLEE_RECOVER_MS = 60_000;
/** While recovering, a melee hostile this close starts a flight. */
const FLEE_RECOVER_SCAN = 12;
/**
 * Ranged mobs: running from them in a line only gives them targets; not a reason for a recovery flight. Track E13: hostiles.ts
 * RANGED_TYPES itself (this list had no parched, breeze or shulker, and an `evoker` id the game does not have).
 */
export const FLEE_RANGED: ReadonlySet<string> = RANGED_TYPES;
/** A flight ends after this long, or this long without a threat within 16. */
const FLEE_MAX_MS = 60_000;
const FLEE_SAFE_MS = 2000;
/**
 * Caught: a threat within FLEE_CAUGHT_RANGE (horizontal) that keeps hitting the bot for FLEE_CAUGHT_MS of a
 * flight ends it `cornered` (guard then defends in place). On the Realm 2026-11-05 a drowned as fast as the
 * bot by the water kept hitting it through 11 s of running away (7 to 0 health) without a blow back.
 */
export const FLEE_CAUGHT_RANGE = 2.5;
export const FLEE_CAUGHT_MS = 3000;

// ---- Track M1: the floors (docs/pve.md "Never die to common mobs (Track M1)", ADR 0079) ----
/** Health at or below this with a melee mob within FLOOR_CRITICAL_RANGE: running is not working; the next floor. */
export const FLOOR_CRITICAL = 4;
export const FLOOR_CRITICAL_RANGE = 3;
/** Health at or below this with a hit taken in the last 3 s (an archer, a witch) is critical too. */
export const FLOOR_CRITICAL_HIT = 8;
/** Track M1 round 2: with SEAL_CROWD shooters in sight and the shell possible, critical from this health (hit in the last 3 s). */
export const FLOOR_CRITICAL_CROWD = 14;
export const SEAL_CROWD = 3;
/** A flight that ended caught or cornered this recently (ms) counts as failed (the next floor). */
export const FLOOR_FAILED_MS = 20_000;
/** The elytra flee and the seal-in are tried at most once in this long (ms) each. */
export const FLOOR_RETRY_MS = 30_000;
/**
 * Track M3: with `fleeFly` on and a takeoff possible, the elytra flee is the first answer to a flee trigger with no blade
 * in the hotbar (a fist does not end a fight: every bare-handed death of Tracks M1 and M2 was a bot running on foot at
 * low health), and with a blade once the health is at most this (the flight on foot first: a blade wins most fights, and
 * a takeoff costs the chestplate for the flight).
 */
export const FLY_FIRST_HEALTH = 6;
/**
 * Track M3 (docs/flight.md "The landing looks at hostile mobs"): the reflex's reach (eye to box) while a flight comes down
 * onto its landing. The server takes a hit up to 6.2 (docs/pve.md "Server rules"); on the ground the reflex strikes at 3.9
 * because a strike there pushes the mob away. A body that sinks onto a mob pushes nothing aside (the knockback goes along
 * the line from the body, here straight down): what counts is the strikes that land before the mob can reach up, and a
 * zombie hit a body whose feet were 2 to 3 blocks over its own. From 5.5 a body sinking a fifth of a block a tick strikes
 * twice before that.
 */
export const FLIGHT_STRIKE_REACH = 5.5;
/** Track M3: with no blade and the elytra flee able, a shooter in sight within FLEE_SCAN starts it below this health (as WITCH_FLEE_HEALTH for the flight on foot). */
export const FLY_SHOOTER_HEALTH = 14;
/** Sealed in: open up again once the health is back to this and no mob is within 16 or it is day (at most after SEAL_MAX_MS). */
export const SEAL_LEAVE_HEALTH = 20;
const SEAL_MAX_MS = 300_000;
/** A potion's level motion within this angle's cosine of the line to the bot is coming at it (about 50 degrees: she aims where the bot was). */
const POTION_AIM_COS = 0.65;
/** Builds of a surface shell before the bot settles in it as it is (the second from where the body is then). */
const SEAL_TRIES = 2;
/**
 * Archers a lone duel closes in on (Track M1): running in the open from one keeps the bot in its range. Track E13: hostiles.ts
 * ARCHER_TYPES itself, the one archer list (this copy had no parched). By type only: a drowned with a trident is an archer for
 * the fight's sprint-in (isArcher) and a melee mob for these rules, as before (the duel, the work fight and the shooter
 * memory were measured on skeletons and pillagers; a drowned walks in and strikes as well as it throws).
 */
export const DUEL_ARCHERS: ReadonlySet<string> = ARCHER_TYPES;
/** A duel with a lone archer gives up after this much health lost in 6 s (a melee duel: 4). */
export const DUEL_ARCHER_LOST = 8;
/** Archers alone up to this many are a duel (more: run, then the floors). */
export const DUEL_ARCHERS_MAX = 2;
/** Below this health a witch within FLEE_SCAN starts a flight (its harming potion is 6 at once). */
export const WITCH_FLEE_HEALTH = 14;
/** With a blade at this health or more a witch within WITCH_FIRST_RANGE is fought first (firstTarget). */
export const WITCH_ENGAGE_HEALTH = 8;
export const WITCH_FIRST_RANGE = 12;
/** ... and within this (her throw range) at any health. */
export const WITCH_CLOSE = 8;
/** The way to her: no other melee mob within this of the line (blocks), beyond WITCH_WAY_OWN from the bot (the reflex's). */
export const WITCH_WAY_CLEAR = 2;
export const WITCH_WAY_OWN = 3;
/** A splash potion first seen within this of a witch (blocks, her hand at about 1.5 up) is hers. */
export const WITCH_THROW_NEAR = 2.5;
/** After her throw the next is 61 ticks (3 s) away: she is fought first at any health within WITCH_FIRST_RANGE for this (ms). */
export const WITCH_WINDOW_MS = 2000;
/**
 * Track E12 (`workGuard`, docs/early-game.md "The mine's dangers (Track E12)", ADR 0119): with guard off, an archer within
 * this (feet, 3D) with a line on a bot at work that aims at it or hit it in the last 10 s is fought by guard's fight.
 */
export const WORK_ARCHER_RANGE = 16;
/** Track E12: the user processes that are not work for `workGuard` (a kill job fights already; a walk the owner sent goes on). */
export const WORK_GUARD_SKIP: ReadonlySet<string> = new Set(['kill', 'follow', 'come', 'goto']);
/**
 * Track E12: an archer is fought for the work only while it is the only one in WORK_ARCHER_RANGE with a line on the bot,
 * aiming or not (two: the fight on one left the other shooting, and a second fight begun at 12 health ended in a death).
 */
export const WORK_ARCHERS_MAX = 1;
/** Track E12: a fight for the work on an archer starts only at this health or more (an approach from 16 costs 4 to 8). */
export const WORK_ARCHER_HEALTH = 14;
/**
 * Track M11 (`workGuard`, docs/pve.md "workGuard"): a witch a fight for the work went for and did not kill is held: the work
 * waits and she is fought again (not ignored for the fight's 30 s) while she is alive and within this (feet, 3D) or aiming
 * at the bot. On the Realm (2026-11-22) the fight's approach failed at once, she was ignored 30 s, and the job walked off
 * exploring with her following and throwing (13 damage).
 */
export const WORK_WITCH_HOLD_RANGE = 16;
/** Track M11: a hold lasts at most this from the first fight (a witch no fight reaches, behind a wall or over a ravine), ms. */
export const WORK_WITCH_HOLD_MS = 60_000;
/** Track M11: a held witch is fought again this long after a fight on her ended, ms (the hold stands still in between). */
export const WORK_WITCH_REFIGHT_MS = 1000;
/**
 * Track M11: fights in a row on the held witch that ended `unreachable` end the hold (she stands where no fight gets to,
 * on a pillar or over a gap: standing still in her throw range is worse than the job going on; the fight's 30 s ignore
 * then applies as before). The Realm's first fight was unreachable only because the body was inside a block.
 */
export const WORK_WITCH_UNREACHABLE_MAX = 2;
/** The dodge (mobDodge, no blade): shooters within this (and in sight) are dodged; a melee mob within DODGE_MELEE ends it. */
export const DODGE_RANGE = 16;
export const DODGE_MELEE = 6;

// ---- Track M2: hold the ground against what a fist keeps out (docs/pve.md "Track M2") ----
/** At most this many melee mobs within HOLD_RANGE are held off by the reflex (it strikes 3 a tick, each every 10 ticks). */
export const HOLD_MAX = 3;
export const HOLD_RANGE = 8;
/** Two melee hits within this long (ms) while it holds: the fist is not keeping them out, run. */
export const HOLD_HITS_MS = 3000;
/** Eat in a flight from this food down (the survival kit's urgent bite, too): below 7 the body cannot sprint. */
export const FOOD_SPRINT_EAT = EAT_BEFORE_SPRINT_LOST;

export interface HoldInput {
  /** The reflex is on and able (mobReflex, on the ground, not flying). */
  reflex: boolean;
  /** Melee mobs (not creepers) within HOLD_RANGE. */
  melee: number;
  /** A creeper within FLEE_CREEPER_RANGE, or a ranged mob (an archer, a witch) within FLEE_SCAN with a line on the bot. */
  other: boolean;
  /** Melee hits taken within HOLD_HITS_MS. */
  meleeHits: number;
}

/**
 * Track M2: stand and let the reflex strike instead of running with the back turned. The bare idle nights of Track M1 and the
 * bare `mixed-8` runs with the reflex off died the same way: a bot at 1 to 4 health ran 40 blocks with a zombie at 2 to 4
 * behind it, hit every few seconds, until it was dead (a zombie is as fast as a running bot, and at food 6 or less the bot
 * cannot sprint). A fist strike every 10 ticks from 3.9 keeps one zombie out of its own reach (pve-rules `kite`: 16 to 23
 * strikes and no hit in 20 s), and the reflex strikes 3 in a tick. So with the reflex able, up to HOLD_MAX melee mobs near and
 * nothing that a stand does not answer (a creeper's blast, an archer's or a witch's line), the low-health flight does not
 * start, and a running one ends; two melee hits within HOLD_HITS_MS say the fist is not holding them, and the bot runs.
 */
export function holdGround(i: HoldInput): boolean {
  return i.reflex && i.melee >= 1 && i.melee <= HOLD_MAX && !i.other && i.meleeHits < 2;
}

// ---- Track M4: early-game kits (docs/pve.md "Track M4", ADR 0079 addendum) ----
/**
 * Track M4: the rules of this track, each a switch the gauntlet can turn off to measure it (test/e2e/gaunt-mobs.test.ts
 * MOBS_RULES, MOBS_AB_RULE). Not settings: they only change choices the guard and the flight on foot already make.
 */
export interface PveRules {
  /** A leg of the flight on foot is kept FLEE_LEG_HOLD_MS, and left for `away` only with a threat inside FLEE_AWAY - FLEE_LEG_BAND (fleeLeg). */
  legHold: boolean;
  /** With a blade at low health near home, archers alone are closed in on instead of stood in front of (archerDuelTarget). */
  archerDuel: boolean;
  /** The away and far legs run FLEE_LONG farther than they need, so the walk sprints (fleeRadius). */
  fleeLong: boolean;
  /**
   * The bot's own poison (mob_effect): a tick of it is not a mob's hit (MobTracker `poison` cause: no attacker guess, no
   * duel input), and low health and the duel's margin count the health the poison will leave (healthAfterPoison).
   */
  poison: boolean;
  /** Home is no place to flee to while an archer or a witch stands within SHOOTER_HOME of it (fleeLeg `homeShot`). */
  shooterHome: boolean;
  /**
   * Track M5: at low health the way home has to be clear of archers and witches too, not only home (shooterOnWay): no live
   * one within SHOOTER_WAY of the line from the bot to home, seen or not. The danger being over (nothing within FLEE_SCAN
   * for 2 s) no longer makes home clear on its own then.
   */
  shooterWay: boolean;
  /**
   * Track M5: no bite in the flight on foot while the bot is poisoned and a witch or an archer is within FLEE_SCAN + 8, seen
   * or not (poisonBite), unless the food is down to FOOD_SPRINT_EAT. A bite slows the body for 1.6 s and heals nothing while
   * the poison holds the health down.
   */
  poisonBite: boolean;
  /**
   * Track M5: the witch is not the first target at WITCH_CROWD_HEALTH or under while an archer with a line on the bot is
   * within FLEE_SCAN (firstTarget): her harming (6) and one arrow (4) are the health. The floors decide as for any mob.
   */
  witchCrowd: boolean;
  /**
   * Track M6: the flight on foot also starts at fleeHealth or over when the health is at most one round of the shooters
   * in sight (volleyLow): VOLLEY_MIN_SHOOTERS or more archers within FLEE_SCAN and a witch within VOLLEY_WITCH_RANGE, each
   * counted at its own last hit on the bot (before one: VOLLEY_ARROW less the armour worn, VOLLEY_HARMING). Only when the
   * flee starts.
   */
  volley: boolean;
  /**
   * Track M6: with no blade in the hotbar an archer with a line on the bot within FLEE_SCAN is run from at any health
   * (bareArcher), not fought with a fist: a pillager hits every 47 ticks from 2 to 5 blocks while a fist chases it, and
   * about every 26 s from 8 to 10 once the flight on foot keeps it there.
   */
  bareArcher: boolean;
  /**
   * Track M7: with a diamond or netherite sword and the reflex on, guard's fight on a witch it fights first is a rush
   * (FightOptions.rush): the approach sprints, the shield stays down, no re-pick within reach, a creeper in between only lit
   * or within RUSH_CREEPER_NEAR. The witch's poison was the live kit's lowest health (witchRushes).
   */
  witchRush: boolean;
  /**
   * Track M7: a carried milk bucket is drunk when the poison would still take more than CURE_MIN_LOSS, with no witch within
   * CURE_WITCH_CLEAR (she poisons again a bot that is not poisoned) and every mob FLEE_EAT_CLEAR away (milkCure). The live
   * kit carries no milk: without it nothing changes.
   */
  milkCure: boolean;
  /**
   * Track M9: with no blade carried, a `far` leg with an archer within FLEE_SCAN + 8 (followingArcher) runs FOLLOW_RUN past it (followRunRadius,
   * no FLEE_FAR cap), so the walk is long and straight enough to sprint the whole way: a pillager runs about as fast as a
   * sprint and stops to shoot only within 8, while the short legs before sprinted a third of the time and let it close in.
   * A long leg the planner cannot find falls back to fleeRadius for the rest of the flight. No home leg while that archer
   * is within FLEE_SCAN + 8 (the way home turns the body back towards it). A flight that gives up (60 s) with the archer
   * still within FLEE_SCAN + 8 (seen or not) ends with no cooldown, so the next one starts as soon as it is seen, not
   * after the 2 s in which guard chased it with a fist. On by default (no kit `pillager-1`, 10 a side: 6 deaths to 0;
   * a bot with a blade is untouched).
   */
  followRun: boolean;
  /**
   * Track M9: with no blade carried, a `far` leg from an archer that follows (followingArcher) jumps while it sprints on straight level runs
   * (GotoOptions.sprintJump, follower.ts sprintJumpOk) while the food is over SPRINT_JUMP_FOOD. A new way of moving the
   * body: off by default.
   */
  sprintJump: boolean;
  /**
   * Track M9: no blade carried, a lone archer in sight (no other hostile within BLADE_LONE), health BLADE_CRAFT_HEALTH or
   * over and the materials for a sword: craft one where the bot stands (tasks/process/blade.ts) instead of running, then
   * guard fights with it. Places a crafting table and leaves it standing: off by default.
   */
  craftBlade: boolean;
  /**
   * Track M10: with no blade carried, a flight on foot that started within BACK_HOME_ARM of home leaves the bot armed to go
   * back; once nothing runs and the way is clear (backHomeBlock: no melee threat within FLEE_SCAN + 8 of the bot and no
   * archer or witch within FLEE_SCAN of it, seen or not; none within SHOOTER_HOME of home or SHOOTER_WAY of the way there)
   * it walks home as the home return (returnHome). In the flight the home leg is not taken past an archer or a witch on the
   * way (shooterWay at any health). Before it nothing took a bot home after a flight that gave up: the long case's skeleton
   * row stood 55 to 100 out until the run ended, and the flight's own home leg flipped back to `far` within 0.5 s.
   */
  backHome: boolean;
  /**
   * Track M10: with no blade carried and an archer following, the flight on foot may take its home leg while home lies ahead
   * (homeAhead: every archer and witch known is farther from home than the bot by FOLLOW_HOME_LEAD and none is on the way),
   * and that leg closes the doors and gates it opens behind it, so a home with walls and a door shuts the follower out. Guard
   * does not chase an archer out of reach with a fist (it backs off and shoots from 2 to 5 blocks). Off by default (a home
   * leg with the archer behind, and a door closed by the flight).
   */
  followHome: boolean;
  /**
   * Track E3 (docs/pve.md "The blade strike"): the reflex strikes with the hotbar's blade when the hand holds a block, a
   * digging tool between digs or nothing, and the hand goes back in the same tick (combat.ts swapHandOk). A pillar holds
   * its block: 0.9 a strike against a stone sword's 5.
   */
  bladeStrike: boolean;
  /**
   * Track E7 (docs/pve.md "A creeper in reach", ADR 0079 decisions 70 and 71, ADR 0104): with guard off (nothing fights
   * the creeper: guard's own hit and run does when it is on), the body leaves a creeper that the reflex's strikes do not
   * deal with (the flight on foot, `creeper`, whatever the health): one within CREEPER_BLAST_REACH whose fuse has burned
   * CREEPER_LIT_BACKOFF ticks, or one within CREEPER_BACKOFF_RANGE while the strike in hand is too weak to keep it off
   * (creeperStrikesEnough). The reflex strikes on as before: its strikes are what cut the fuse. On a fresh world a mine
   * step's walk had a creeper and a spider on it, the reflex struck, the fuse burned out and the blast took the bot from
   * 18 to 0. **Off**: in the tunnel replica (test/e2e/early-creeper.test.ts, 5 runs a side a cell) it was better in no
   * cell: the strikes alone killed 14 of 15 creepers with one far blast (2.8 damage), and the back-off left 4 creepers
   * alive and took its one blast at 15.4 (the flight starts in the pocket the mine dug: 2 blocks in 3 s).
   */
  creeperReach: boolean;
}
export const PVE_RULES_DEFAULT: Readonly<PveRules> = { legHold: true, archerDuel: true, fleeLong: true, poison: true, shooterHome: true, shooterWay: true, poisonBite: true, witchCrowd: true, volley: true, bareArcher: true, witchRush: true, milkCure: true, followRun: true, sprintJump: false, craftBlade: false, backHome: true, followHome: false, bladeStrike: true, creeperReach: false };
/** Track M10 (`followHome`): home is ahead when every archer and witch is this much farther from it than the bot (blocks, level). */
export const FOLLOW_HOME_LEAD = 4;
/** Track M10 (`backHome`): a flight on foot that starts within this of home (blocks, level) arms the way back. */
export const BACK_HOME_ARM = 48;
/** Track M10 (`backHome`): armed this long after the last flight at most (ms); a bot still out then guards itself where it is. */
export const BACK_HOME_MS = 10 * 60_000;
/** Track M10 (`backHome`): within this of home (blocks, level) the bot is home: disarmed. */
export const BACK_HOME_AT = 3;
/** Track M10 (`backHome`): looked at every this many ticks. */
const BACK_HOME_EVERY = 10;

/**
 * Track M10 (`backHome`): why the bot may not walk home yet, or undefined when it may. `melee`: threats other than archers
 * and witches within FLEE_SCAN + 8 of the bot; `shooter`: an archer or a witch within FLEE_SCAN of the bot (seen or not);
 * `homeShot`: one within SHOOTER_HOME of home; `wayShot`: one within SHOOTER_WAY of the way there (shooterOnWay, the
 * remembered ones too). An archer 16 to 24 off to the side does not hold the walk: the way does not pass within its range.
 */
export function backHomeBlock(i: { melee: number; shooter: boolean; homeShot: boolean; wayShot: boolean }): string | undefined {
  if (i.melee > 0) return `a hostile within ${FLEE_SCAN + 8}`;
  if (i.shooter) return `an archer or a witch within ${FLEE_SCAN}`;
  if (i.homeShot) return `an archer or a witch within ${SHOOTER_HOME} of home`;
  if (i.wayShot) return `an archer or a witch within ${SHOOTER_WAY} of the way home`;
  return undefined;
}
/** Track M9 (`followRun`): a far leg from an archer that follows ends this far beyond the archer's distance (blocks). */
export const FOLLOW_RUN = 32;
/** Track M9 (`followRun`): the radius of such a leg (from every threat). */
export function followRunRadius(nearest: number): number {
  return (Number.isFinite(nearest) ? nearest : FLEE_AWAY) + FOLLOW_RUN;
}
/** Track M9 (`sprintJump`): the sprint-jump only while the food is over this (EAT_BEFORE_SPRINT_LOST: the flight eats from there down). */
export const SPRINT_JUMP_FOOD = EAT_BEFORE_SPRINT_LOST;
/** Track M7 (`milkCure`): milk is drunk only when the poison would still take more than this (health). */
export const CURE_MIN_LOSS = 3;
/** Track M7 (`milkCure`): no milk with a live witch this close (blocks): she throws poison at a bot that is not poisoned. */
export const CURE_WITCH_CLEAR = 16;
/** Track M7 (`milkCure`): what is drunk. */
export const CURE_ITEM = 'milk_bucket';
/** Track M7 (`milkCure`): checked every this many ticks. */
const CURE_EVERY = 5;
/** Track M6 (`volley`): an archer that has not hit the bot yet counts this much (an arrow or a bolt with no armour is 3 to 5). */
export const VOLLEY_ARROW = 4;
/** Track M6 (`volley`): a witch that has not hit the bot yet counts her harming potion (6 through any armour). */
export const VOLLEY_HARMING = 6;
/** Track M6 (`volley`): one shooter's last hit counts at most this (an arrow or a bolt on normal is 3 to 5, her harming 6). */
export const VOLLEY_SHOT_MAX = 6;
/** Track M6 (`volley`): a witch counts within this (blocks): she throws from 8, not from 12. */
export const VOLLEY_WITCH_RANGE = 10;
/** Track M6 (`volley`): the rule is for a group: at least this many shooters in sight (one archer is the duel's). */
export const VOLLEY_MIN_SHOOTERS = 2;

/**
 * Track M6 (`volley`): one round of the shooters in sight: the sum of what each one did with its last hit, else its default.
 * An archer's default is VOLLEY_ARROW less the bot's own armour (`armour`: points worn, 0 to 20; each point takes 4 % off, as
 * the game's armour does), so a group of skeletons that has not hit yet is not taken for 4 a shot against the netherite set
 * (1.5 an arrow measured through it). Her harming is magic: no armour takes from it.
 */
export function volleyRound(shots: readonly { kind: 'archer' | 'witch'; last?: number }[], armour = 0): number {
  const arrow = VOLLEY_ARROW * (1 - Math.min(20, Math.max(0, armour)) / 25);
  return shots.reduce((s, x) => s + (x.last ?? (x.kind === 'witch' ? VOLLEY_HARMING : arrow)), 0);
}
/** Track M5 (`witchCrowd`): at this health or under, a witch with an archer shooting is not fought first (harming 6 + an arrow 4). */
export const WITCH_CROWD_HEALTH = 10;
/** Track M5 (`witchCrowd`): only with a blade below this score (combat.ts bladeScore: a diamond sword's): stone and iron. */
export const WITCH_CROWD_BLADE = 207;
/** Track M5 (`shooterWay`): an archer or a witch this close to the way home (blocks, level) keeps a bot at low health from it: a skeleton's range. */
export const SHOOTER_WAY = 16;
/**
 * Track M5: an archer or a witch the server stopped sending this far from the bot or more (blocks) is out of range, not
 * dead: remembered. bds-pve sent skeletons 24, 40 and 56 off and not 72, 88 or 104 (pve-m5 `range`, 2026-11-16).
 */
export const SHOOTER_LOST_FAR = 48;
/** Track M5: how long such an archer or witch is remembered at its last place (ms). */
export const SHOOTER_MEMORY_MS = 60_000;

/** Track M5: the level distance from `p` to the segment a-b (blocks). */
export function segmentDistance(p: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}
/** Track M4: an archer or a witch this close to home (blocks, level) keeps the flight on foot from going home. */
export const SHOOTER_HOME = 16;
/**
 * Track M4: the extra length of an away or far leg (blocks). The walk sprints only while more than 8 blocks of straight path
 * are left (follower.ts runLength: 5 plus the 3 it keeps to stop in), and a leg was about as long as that: in the traces of
 * the early-kit screen the flight on foot had the sprint in 13 % of its away ticks and 0 % of its far ticks and covered
 * 0.18 to 0.20 blocks a tick, under a walk's 0.216 (a sprint is 0.281).
 */
export const FLEE_LONG = 8;

/** The radius of a runAway leg of the flight on foot: away FLEE_AWAY + 4; far nearest + 6 within [FLEE_AWAY + 4, FLEE_FAR]; `long` FLEE_LONG more. */
export function fleeRadius(phase: 'away' | 'far', nearest: number, long: boolean): number {
  const base = phase === 'far' ? Math.min(FLEE_FAR, Math.max(FLEE_AWAY + 4, nearest + 6)) : FLEE_AWAY + 4;
  return long ? Math.min(FLEE_FAR, base + FLEE_LONG) : base;
}
/** Track M4: the archer duel at home holds within this of home (blocks, level): the duel's own walk takes it this far out. */
export const ARCHER_DUEL_HOME = 16;
/**
 * Track M4: no archer duel at this health or under (after the poison): an arrow is 3 to 5 with no armour. With the duel at
 * any health and the poison rule on, the stone kit's `seal-5` fought two skeletons at 2 to 5 health and died in 4 of 5.
 */
export const ARCHER_DUEL_MIN = 5;
/** Track M4: a new leg of the flight on foot holds this long (ms) unless a threat comes within FLEE_URGENT. */
export const FLEE_LEG_HOLD_MS = 2000;
/** Track M4: home or far is left for away only when the nearest threat is this much inside FLEE_AWAY. */
export const FLEE_LEG_BAND = 3;

export type FleeLeg = 'away' | 'home' | 'far';
export interface FleeLegInput {
  phase: FleeLeg | 'seal' | 'sealed' | 'dodge';
  /** A shelter or home to go to. */
  dest: boolean;
  /** The nearest threat (blocks, level; Infinity with none). */
  nearest: number;
  /** Home lies clear of the threats (homeClear), or the flight was cornered, or the danger is over (2 s). */
  homeOk: boolean;
  /** Run FLEE_FAR from the start with the nearest threat FLEE_AWAY off: home around the threat. */
  farEnough: boolean;
  /** Since the current leg began (ms). */
  sinceLeg: number;
  /** How long `homeOk` has held without a break (ms; undefined: not known, no wait). */
  homeOkMs?: number;
  /** Track M4 (`shooterHome`): an archer or a witch within SHOOTER_HOME of home: no home leg, not even far enough out. */
  homeShot?: boolean;
  /** The legHold rule (PveRules). */
  hold: boolean;
}

/**
 * The leg of the flight on foot. Without `hold` the rule of Track W: home once FLEE_AWAY clear and home clear (or cornered,
 * or safe), else far once FLEE_AWAY clear, else away. Track M4 (`hold`): on the gauntlet a bot at 1 to 3 health (a witch's
 * poison stops at 1) changed leg every 10 to 20 ticks while a husk walked after it at 10 to 12 and a skeleton came in and out
 * of view at 15; every change is a new walk, and a new walk stops the body, so it ran at a walk and the next arrow killed it
 * (iron and no-kit `mixed-8`). So a leg holds FLEE_LEG_HOLD_MS unless a threat comes within FLEE_URGENT, and home or far
 * goes back to away only with the nearest threat inside FLEE_AWAY - FLEE_LEG_BAND (far when home is not clear then).
 */
export function fleeLeg(i: FleeLegInput): FleeLeg {
  if (i.homeShot) i = { ...i, homeOk: false, farEnough: false };
  let base: FleeLeg;
  if (i.dest && (i.nearest >= FLEE_AWAY || i.phase === 'home') && i.homeOk) base = 'home';
  else if (i.nearest >= FLEE_AWAY || i.phase === 'far') base = 'far';
  else base = 'away';
  if (base === 'far' && i.dest && i.farEnough && i.nearest >= FLEE_AWAY) base = 'home';
  if (!i.hold || base === i.phase || (i.phase !== 'away' && i.phase !== 'home' && i.phase !== 'far')) return base;
  // never on towards a home that is no longer clear: out to far (or away with the threat close)
  const notHome: FleeLeg = i.nearest >= FLEE_AWAY - FLEE_LEG_BAND ? 'far' : 'away';
  if (i.sinceLeg < FLEE_LEG_HOLD_MS && i.nearest > FLEE_URGENT) return i.phase === 'home' && !i.homeOk ? notHome : i.phase;
  // home again only once it has stayed clear for the hold (a skeleton at the edge of view made it clear every other look)
  if (base === 'home' && i.phase !== 'home' && (i.homeOkMs ?? Infinity) < FLEE_LEG_HOLD_MS) return i.phase;
  if (base === 'away' && i.nearest >= FLEE_AWAY - FLEE_LEG_BAND) return i.phase === 'home' && !i.homeOk ? 'far' : i.phase;
  return base;
}

/** The floors against mobs, in order (the health rule): see `pveFloor`. */
export type Floor = 'fight' | 'eat' | 'backoff' | 'fly' | 'seal' | 'defend';

export interface FloorInput {
  /** A flee trigger holds (low health with a hostile near, a creeper at low health, the crowd rule). */
  danger: boolean;
  /** One melee mob and the health for 3 more of its hits (fight it instead of running). */
  canDuel: boolean;
  /** The nearest threat (blocks, level). */
  nearest: number;
  health: number;
  food: number;
  hasFood: boolean;
  /** A flight ended caught or cornered within FLOOR_FAILED_MS. */
  failed: boolean;
  /** Health at most FLOOR_CRITICAL with a melee mob within FLOOR_CRITICAL_RANGE, or at most FLOOR_CRITICAL_HIT and hit in the last 3 s. */
  critical: boolean;
  /** The elytra flee can go now (setting on, the kit at hand, open sky over the body, not tried within FLOOR_RETRY_MS). */
  fly: boolean;
  /** Track M3: the elytra flee comes before the flight on foot (no blade in the hotbar, or the health at most FLY_FIRST_HEALTH). */
  flyFirst?: boolean;
  /** The seal-in can go now (setting on, enough blocks, a placer, not tried within FLOOR_RETRY_MS). */
  seal: boolean;
}

/**
 * The health rule, in order: no danger (or a duel that is worth it): fight on; clear of every mob by FLEE_EAT_CLEAR with
 * food to eat: eat; else back off (the flight on foot, the reflex striking behind) unless running has failed (caught,
 * cornered) or the health is critical next to a melee mob; then the elytra flee, then the seal-in, then defend in place.
 * Track M3: where the elytra flee can go and `flyFirst` holds, it comes before the flight on foot.
 */
export function pveFloor(i: FloorInput): Floor {
  if (!i.danger || i.canDuel) return 'fight';
  if (i.nearest >= FLEE_EAT_CLEAR && i.hasFood && i.food < 20 && i.health < 20) return 'eat';
  if (i.fly && i.flyFirst) return 'fly';
  if (!i.failed && !i.critical) return 'backoff';
  if (i.fly) return 'fly';
  if (i.seal) return 'seal';
  return 'defend';
}

/** Track M3: what an elytra flee came to, as the guard reads it (skills/fly/flee.ts FleeFlight). */
export interface FleeFlightResult {
  /** The body stands on ground again after a flight. */
  ok: boolean;
  /** A takeoff was made. */
  flew: boolean;
  reason?: string;
  line: string;
}

export class PveController {
  readonly mobs: MobTracker;
  readonly combat: CombatController;
  readonly follower: FollowController;
  readonly hotbar: Hotbar;
  readonly processes: ProcessManager;
  readonly settings: RuntimeSettings;
  /** The skills with the live settings applied to every walk. */
  readonly mover: PveSkills & ProcessMover;
  private guardOn: boolean;
  readonly collectRadius: number;
  readonly d: PveDeps;
  readonly log: Logger;
  private readonly ownManager: boolean;
  readonly guardProcess: GuardProcess;
  readonly fleeProcess: FleeProcess;
  /** Mobs not to pick again until the time (performance.now()). */
  readonly ignore = new Map<bigint, number>();
  /**
   * Track M11 (`workGuard`): the witch a fight for the work went for and has not killed: since (the first fight's end), the
   * last fight's end, the fights, the fights in a row that ended unreachable (performance.now() ms). Cleared at her death,
   * out of WORK_WITCH_HOLD_RANGE and not aiming, WORK_WITCH_HOLD_MS, WORK_WITCH_UNREACHABLE_MAX, or no job at work.
   */
  workWitch: { rid: bigint; since: number; endedAt: number; fights: number; unreachable: number } | undefined;
  /** Track AO: why and since when each ignored mob is ignored (status, the hit rule). */
  readonly ignoreWhy = new Map<bigint, targeting.IgnoreNote>();
  /** Track AO: bounded probe plans to guard candidates (cached per mob for 5 s). */
  readonly pathReach: PathReach;
  private readonly unsubs: (() => void)[] = [];
  readonly stats = { fights: 0, kills: 0, flees: 0, guardTriggers: 0 };
  /** The survival kit (eat, equip) for flee eating and trip readiness; wired by chat/commands-pve.ts (Track W). */
  kit: (() => TripKit | undefined) | undefined;
  /**
   * The stock steps of the trip readiness, in order (`addTripStock`): Track K1 (chat/commands-milk.ts, ADR 0096) the milk
   * buckets missing to `milkKeep` out of the carried boxes and (at home) the home chests; Track R9 (chat/commands-rockets.ts,
   * ADR 0097) rockets crafted from what is carried before a long trip that may fly. `needed(to)`: the trip's goal, if known.
   */
  readonly tripStocks: TripStock[] = [];
  /** The last hit the bot took (Track W: how many more it can take). */
  lastHit: { damage: number; at: number } | undefined;
  private readonly recentHits: { damage: number; at: number }[] = [];
  /** Track M6 (`volley`): the last hit each mob (by the hit guess) and each type did to the bot. */
  private readonly lastDamageBy = new Map<bigint, number>();
  private readonly lastDamageByType = new Map<string, number>();
  /** Track M2: when the last melee hits came (performance.now ms; the hit guess blamed a melee mob). */
  private readonly meleeHitTimes: number[] = [];
  /** Far players from the locator bar (Track W): `!come` beyond the entity range. */
  readonly locator: PlayerLocator;
  /** Track M1: strikes every hostile within reach under every activity (the `mobReflex` setting). */
  readonly reflex: Reflex;
  /** Track M1: hits taken by mob type (the attacker guess; `unknown` without one), for !pve and the counters. */
  readonly taken: Record<string, number> = {};
  /** Track M1: the floors taken (backoff, eat, fly, seal, defend), for the counters. */
  readonly floors: Record<string, number> = {};
  /** Track M4: this track's rules (PveRules), all on; the gauntlet turns one off to measure it. */
  readonly rules: PveRules = { ...PVE_RULES_DEFAULT };
  /**
   * Track M3 (docs/pve.md "The elytra flee"): the elytra flee as a flight mode, wired by chat/commands-pve.ts from the
   * flight's own entry point (chat/commands-fly.ts `flee`). `ready`: a flee can take off where the body stands now (the
   * elytra and the rockets at hand, open sky over it, no flight in the air); `go`: take off and land on safe ground far
   * from the hostiles, resolving with what happened (at once when no takeoff was made); `cancel`: drop it on the ground,
   * land it in the air; `active`: from the ask until its flight has ended.
   */
  fleeFlight: { ready(): boolean; go(why: string): Promise<FleeFlightResult>; cancel(): boolean; active(): boolean } | undefined;
  /** Track M3: what the last elytra flee came to (the status, the tests). */
  lastFleeFlight: FleeFlightResult | undefined;
  /** Track M9 (`craftBlade`): the crafter's side of the blade craft, wired by chat/commands-craft.ts. */
  bladeSmith: BladeSmith | undefined;
  /** Track M9 (`craftBlade`): the blade craft (tasks/process/blade.ts). */
  readonly bladeProcess: BladeProcess;
  /** Track E12 (`creeperRise`): up from a creeper whose fuse burns under the feet (tasks/creeper-rise.ts). */
  readonly riseProcess: RiseProcess;
  /** Track E13 (`workArchers`): two archers or more shooting at a job at work (tasks/work-archers.ts). */
  readonly archersProcess: ArchersProcess;
  /** Track M3: an elytra flee was asked for and has not answered yet. */
  flyAsked = false;
  /**
   * Track M3 (docs/flight.md "The landing looks at hostile mobs"): the reflex may strike under a flight right now (the
   * body is coming down onto its landing, or settling on it; wired by chat/commands-fly.ts with `flyLandMobs` on).
   */
  flightStrike: (() => boolean) | undefined;

  /**
   * The elytra flee has the body: from the ask until its flight has ended. Track M2 found why this is needed: the flee
   * and guard outrank a trip on the ground and took the body straight back in 4 runs of 4 on bds-gaunt, and the takeoff
   * never ran. Since Track M3 the flee's trip holds the body itself (a process over the flight on foot); this keeps the
   * flight on foot and guard from asking for it meanwhile.
   */
  flyHandover(): boolean {
    return this.flyAsked || this.fleeFlight?.active() === true;
  }

  constructor(deps: PveDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    const o = deps.options ?? {};
    this.settings = deps.settings ?? new RuntimeSettings();
    if (!deps.settings) {
      if (o.guard?.radius !== undefined) this.settings.applyStartup('guardRadius', o.guard.radius);
      if (o.fleeHealth !== undefined) this.settings.applyStartup('fleeHealth', o.fleeHealth);
    }
    this.guardOn = o.guard?.on ?? false;
    this.collectRadius = o.collectRadius ?? 8;
    this.log.info(`pve: guard ${this.guardOn ? `on, radius ${this.guardRadius}` : 'off'}, flee below health ${this.fleeHealth}`);
    const { world, loop, source } = deps;
    this.mover = settingsMover(deps.skills as PveSkills & ProcessMover, this.settings);
    this.mobs = new MobTracker(source, {
      entities: () => world.entities,
      selfRuntimeId: () => world.self.runtimeId,
      selfPos: () => (loop.state.ready ? loop.state.pos : undefined),
      headInWater: () => world.blockAt !== undefined && loop.state.ready && headInWater((p) => world.blockAt!(p), loop.state.pos),
      poisonCause: () => this.rules.poison, // Track M4
    });
    this.hotbar = new Hotbar(source, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
    this.combat = new CombatController({
      loop,
      mover: this.mover,
      entities: () => world.entities,
      mobs: this.mobs,
      inventory: world.inventory,
      hotbar: this.hotbar,
      source,
      selfRuntimeId: () => world.self.runtimeId,
      logger: this.log,
    });
    this.follower = new FollowController({ loop, mover: this.mover, entities: () => world.entities, logger: this.log });
    this.pathReach = new PathReach({ nav: () => probeNavOf(this.mover), log: this.log }); // Track AO
    this.locator = new PlayerLocator(source); // Track W
    this.reflex = new Reflex({
      loop,
      entities: () => world.entities,
      mobs: this.mobs,
      attack: (rid, o) => this.combat.attack(rid, o),
      blade: () => this.rules.bladeStrike, // Track E3
      // (Track M3: under a flight only while the body comes down onto its landing: flightStrike; from farther there)
      enabled: () => this.settings.get('mobReflex') && !deps.inactive() && (this.processes.active?.name !== 'flight' || this.flightStrike?.() === true),
      reach: () => (this.processes.active?.name === 'flight' ? FLIGHT_STRIKE_REACH : REFLEX_REACH),
      grid: () => targeting.gridOf(this.mover),
      world,
      // raised, or about to be (an archer's shot due, an arrow flying at us): a strike lowers it (reflex.ts SHIELD_DOWN_TICKS)
      shieldUp: () => this.combat.shield.equipped() && (loop.command.sneak === true || this.combat.shield.threat(loop.state.pos) !== undefined),
      log: this.log,
      ...(deps.metrics ? { metrics: deps.metrics } : {}),
    });
    this.ownManager = deps.processes === undefined;
    this.processes =
      deps.processes ??
      new ProcessManager({
        inactive: () => deps.inactive() || !loop.state.ready,
        onTick: (fn) => loop.onBeforeStep(() => fn()),
        log: this.log,
        metrics: deps.metrics,
      });
    this.fleeProcess = this.processes.add(new FleeProcess(this));
    this.guardProcess = this.processes.add(new GuardProcess(this));
    this.bladeProcess = this.processes.add(new BladeProcess(this)); // Track M9 (`craftBlade`, off by default)
    // Track E12 (`creeperRise`, off by default): added after the flee, so a tie (both at the flee's priority) is the rise's
    this.riseProcess = this.processes.add(
      new RiseProcess({
        on: () => this.settings.get('creeperRise'),
        view: () => this.riseView(),
        goto: (p, timeoutTicks) => this.mover.goto({ type: 'block', p }, { allowBreak: false, allowPlace: true, timeoutTicks }),
        cancel: () => {
          if (this.mover.nav.busy) this.mover.cancel();
        },
        alive: (id) => this.d.world.entities.has(id) && !this.mobs.get(id)?.dead,
        log: this.log,
      }),
    );
    // Track E13 (`workArchers`, on by default; ADR 0120): added after the flee and the rise, so a tie at the flee's
    // priority is this rule's (walled in, no flight runs out of the shell)
    this.archersProcess = this.processes.add(
      new ArchersProcess({
        enabled: () => this.settings.get('workArchers'),
        view: () => this.archersView(),
        archersNear: (p, r) => this.archersNear(p, r),
        health: () => this.health(),
        food: () => this.food(),
        eat: () => {
          const kit = this.kit?.();
          if (!kit || (kit as { busy?: boolean }).busy || !this.hasFood()) return undefined;
          return kit.eat().then((r) => {
            if (r.ok) this.floorUsed('eat');
            return r.ok;
          });
        },
        sealDeps: () => this.sealDeps(),
        stopJob: (job, why) => {
          this.log.warn(`archers: ${why}: stopping ${(job as Process).name}`);
          this.processes.stop(job as Process, 'stopped');
        },
        cancel: () => {
          if (this.mover.nav.busy) this.mover.cancel();
          if (this.combat.busy) this.combat.cancel();
        },
        stand: () => this.d.loop.setCommand({ forward: 0, strafe: 0, sprint: false, jump: false, sneak: false }),
        log: this.log,
      }),
    );
    this.unsubs.push(loop.onBeforeStep(() => this.idleBlock())); // Track M1 round 2: the shield while idle
    this.unsubs.push(loop.onBeforeStep(() => this.noteWitchThrows())); // Track M1 round 2: the witch's throw window
    this.unsubs.push(loop.onBeforeStep(() => this.potionStep())); // Track M1 round 2: out from under her potion
    this.unsubs.push(loop.onBeforeStep(() => this.cureStep())); // Track M7: milk against the poison
    this.unsubs.push(loop.onBeforeStep(() => this.backHomeStep())); // Track M10: home again after a flight
    this.unsubs.push(
      this.mobs.onHit((g, damage, cause) => {
        if (cause === 'drowning') {
          // Track BF: not a fight (no duel rule, no flee from a mob); the air came from the server's `air` value when it sent one
          const air = this.mobs.selfAir;
          this.log.info(`pve: took ${damage.toFixed(1)} damage (drowning: head under water${air !== undefined ? `, air ${air}` : ''}), health ${this.health().toFixed(1)}`);
          return;
        }
        if (cause === 'poison') {
          // Track M4: not a hit by a mob: no duel input (a tick of 1 made 2 x the last hit 2, and the duel went on at 3
          // health), counted apart
          this.taken.poison = (this.taken.poison ?? 0) + 1;
          this.d.metrics?.inc('pve.taken.poison');
          this.log.info(`pve: took ${damage.toFixed(1)} damage (poison, ${(((this.mobs.selfPoison?.until ?? 0) - performance.now()) / 1000).toFixed(0)} s left), health ${this.health().toFixed(1)}, ${this.healthAfterPoison().toFixed(1)} once it ends`);
          return;
        }
        if (damage > 0) {
          // Track M1: hits taken by type (the owner's counters)
          const k = g ? bareType(g.type) : 'unknown';
          this.taken[k] = (this.taken[k] ?? 0) + 1;
          this.d.metrics?.inc(`pve.taken.${k}`);
          // Track W: the duel rule
          this.lastHit = { damage, at: performance.now() };
          // Track M6 (`volley`): what each shooter did with its last hit
          if (g) {
            this.lastDamageBy.set(g.runtimeId, damage);
            if (this.lastDamageBy.size > 64) this.lastDamageBy.delete(this.lastDamageBy.keys().next().value!);
            this.lastDamageByType.set(bareType(g.type), damage);
          }
          this.recentHits.push(this.lastHit);
          if (this.recentHits.length > 20) this.recentHits.shift();
          const ge = g ? this.d.world.entities.get(g.runtimeId) : undefined;
          if (ge && targeting.isMelee(ge, this.mobs)) {
            this.meleeHitTimes.push(this.lastHit.at);
            if (this.meleeHitTimes.length > 10) this.meleeHitTimes.shift();
          }
        }
        this.log.info(`pve: took ${damage.toFixed(1)} damage${g ? ` (probably ${bareType(g.type)} #${g.runtimeId}, ${g.why})` : ''}, health ${this.health().toFixed(1)}`);
      }),
    );
  }

  /**
   * Track E12 (`creeperRise`): what the rise reads: the live creepers within 8 with their fuse, the throwaway blocks, the
   * two cells over the head (free: not solid in the planner's grid, or not known). undefined while inactive or dead.
   */
  riseView(): RiseView | undefined {
    if (this.d.inactive() || !this.d.loop.state.ready || this.health() <= 0) return undefined;
    const me = this.position();
    const creepers: { id: bigint; feet: Vec3; lit: boolean }[] = [];
    for (const e of this.d.world.entities.values()) {
      if (bareType(e.type) !== 'creeper' || this.mobs.get(e.runtimeId)?.dead) continue;
      const f = entityFeet(e);
      if (dist(f, me) > 8) continue;
      creepers.push({ id: e.runtimeId, feet: f, lit: this.mobs.get(e.runtimeId)?.ignited === true });
    }
    if (creepers.length === 0) return { me, creepers, blocks: 0, room: false };
    const grid = targeting.gridOf(this.mover);
    const x = Math.floor(me.x);
    const y = Math.floor(me.y + 0.01);
    const z = Math.floor(me.z);
    const free = (dy: number): boolean => {
      const c = grid?.cls(x, y + dy, z);
      return !c || c.boxes.length === 0;
    };
    return { me, creepers, blocks: throwawayCount(this.d.world.inventory.slots), room: free(2) && free(3) };
  }

  /** Track E13 (`workArchers`): the rule's counts (shells, cleared, jobs stopped, shells left open), for the e2e rows. */
  get archerCounts(): Readonly<Record<string, number>> {
    return this.archersProcess.counts;
  }

  /**
   * Track E13 (`workArchers`): the job at work for the archers rule: the active process is a user job that is work for
   * `workGuard` (not a walk the owner sent, no kill job), guard off, not held by !pause.
   */
  workJob(): Process | undefined {
    if (this.guardOn || this.processes.paused) return undefined;
    const a = this.processes.active;
    if (a?.kind !== 'user' || WORK_GUARD_SKIP.has(a.name)) return undefined;
    if (this.processes.userProcesses().some((p) => p.name === 'kill')) return undefined;
    return a;
  }

  /**
   * Track E13: the live archers within ARCHERS_RANGE and MAX_DY of `me`, seen or not; `shooting`: it aims at the bot with
   * a line on its eye, or hit it in the last 10 s (`workGuard`'s own test).
   */
  archersSeen(me: Vec3): ArcherSeen[] {
    const out: ArcherSeen[] = [];
    let grid: targeting.GridLike | undefined | null = null;
    for (const e of this.d.world.entities.values()) {
      if (!DUEL_ARCHERS.has(bareType(e.type)) || !this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const f = entityFeet(e);
      const d = dist(f, me);
      if (d > ARCHERS_RANGE || Math.abs(f.y - me.y) > targeting.MAX_DY) continue;
      let shooting = this.mobs.hitUsWithin(e.runtimeId, 10_000);
      if (!shooting && this.mobs.targetsUs(e.runtimeId)) {
        if (grid === null) grid = targeting.gridOf(this.mover);
        shooting = !grid || targeting.lineOfSight(grid, { x: me.x, y: me.y + 1.62, z: me.z }, e);
      }
      out.push({ id: e.runtimeId, feet: f, d, shooting });
    }
    return out;
  }

  /** Track E13: the live archers within r (feet, 3D) of p, seen or not. */
  archersNear(p: Vec3, r: number): Vec3[] {
    const out: Vec3[] = [];
    for (const e of this.d.world.entities.values()) {
      if (!DUEL_ARCHERS.has(bareType(e.type)) || !this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const f = entityFeet(e);
      if (dist(f, p) <= r) out.push(f);
    }
    return out;
  }

  /** Track E13 (`workArchers`): what the rule reads; the costly parts only with a job at work and two archers in range, one shooting. */
  archersView(): ArchersView | undefined {
    if (this.d.inactive() || !this.d.loop.state.ready || this.health() <= 0) return undefined;
    const me = this.position();
    const job = this.workJob();
    const archers = job ? this.archersSeen(me) : [];
    if (!job || archers.length < ARCHERS_MIN || !archers.some((a) => a.shooting)) return { me, job, archers, close: false, canCover: false };
    // a melee mob within 6 or a creeper within 8: the flee's and the reflex's, not this rule's
    const close = this.meleeWithin(me, 6) || this.nearestOfKind(me, 8, (t) => t === 'creeper') !== undefined;
    const deps = this.d.loop.state.onGround ? this.sealDeps() : undefined;
    return { me, job, archers, close, canCover: deps !== undefined && canSealHere(deps) };
  }

  dispose(): void {
    this.stop();
    this.processes.stop(this.fleeProcess);
    this.processes.stop(this.guardProcess);
    this.processes.stop(this.riseProcess);
    this.processes.stop(this.archersProcess);
    if (this.ownManager) this.processes.dispose();
    for (const u of this.unsubs.splice(0)) u();
    this.reflex.dispose();
    this.combat.dispose();
    this.follower.dispose();
    this.mobs.dispose();
    this.hotbar.dispose();
    this.locator.dispose(); // Track W
  }

  // ---- state -----------------------------------------------------------------------------------

  get guard(): GuardSettings {
    return { on: this.guardOn, radius: this.guardRadius };
  }

  get guardRadius(): number {
    return this.settings.get('guardRadius');
  }

  get fleeHealth(): number {
    return this.settings.get('fleeHealth');
  }

  /** Track AO: max path blocks to a guard target not within reach (0 = terrain rule only). */
  get guardReach(): number {
    return this.settings.get('guardReach');
  }

  /** Track AO: who guard engages while a user process walks. */
  get guardWhileWalking(): targeting.WalkRule {
    const v = this.settings.get('guardWhileWalking');
    return v === 'reach' || v === 'all' ? v : 'near';
  }

  /** Track AO: the mobs ignored now, with the reason and the seconds left (status, tests). */
  ignored(): { runtimeId: string; type: string; reason: string; leftS: number }[] {
    const now = performance.now();
    const out: { runtimeId: string; type: string; reason: string; leftS: number }[] = [];
    for (const [rid, until] of this.ignore) {
      if (until <= now) {
        this.ignore.delete(rid);
        this.ignoreWhy.delete(rid);
        continue;
      }
      const n = this.ignoreWhy.get(rid);
      out.push({ runtimeId: String(rid), type: bareType(n?.type ?? this.d.world.entities.get(rid)?.type ?? '?'), reason: n?.reason ?? '?', leftS: Math.round((until - now) / 100) / 10 });
    }
    return out;
  }

  /** A process moves the bot (kept for tests; the AFK nudge uses the manager's busy()). */
  ownsMovement(): boolean {
    return this.processes.busy();
  }

  /** One line for !status: idle / guarding r=16 / following Steve / fighting zombie / fleeing / ... */
  behaviour(): string {
    const a = this.processes.active;
    if (a) return a.behaviour?.() ?? a.status().line;
    const users = this.processes.userProcesses();
    if (this.processes.paused && users.length > 0) return `paused (${users.map((p) => p.behaviour?.() ?? p.name).join(', ')})`;
    return this.guardOn ? `guarding r=${this.guardRadius}` : 'idle';
  }

  status(): Record<string, unknown> {
    return {
      behaviour: this.behaviour(),
      guard: this.guard,
      fleeHealth: this.fleeHealth,
      health: this.health(),
      target: this.combat.target ? { runtimeId: String(this.combat.target.runtimeId), type: this.combat.target.type } : null,
      follow: this.follower.status(),
      lastHitBy: this.mobs.lastHitBy ? { type: this.mobs.lastHitBy.type, why: this.mobs.lastHitBy.why, runtimeId: String(this.mobs.lastHitBy.runtimeId) } : null,
      stats: { ...this.stats, ...this.combat.totals },
      reflex: { hits: this.reflex.totals.hits, landed: this.reflex.totals.landed, kills: this.reflex.totals.kills, potionSteps: this.potionSteps }, // Track M1 (potionSteps: round 2)
      taken: { ...this.taken }, // Track M1
      ignored: this.ignored(), // Track AO
      probes: { ...this.pathReach.stats }, // Track AO
    };
  }

  health(): number {
    return this.mobs.selfHealth ?? this.d.world.self.health;
  }

  position(): Vec3 {
    return this.d.loop.state.pos;
  }

  // ---- commands --------------------------------------------------------------------------------

  /** `!guard`: on/off stays in memory; a radius is the `guardRadius` setting (persisted like !set). */
  setGuard(g: Partial<GuardSettings>): GuardSettings {
    if (g.on !== undefined) this.guardOn = g.on;
    if (g.radius !== undefined && g.radius !== this.guardRadius) this.settings.set('guardRadius', g.radius);
    this.log.info(`guard ${this.guardOn ? `on, radius ${this.guardRadius}` : 'off'}`);
    if (!this.guardOn) this.guardProcess.cancelEpisode();
    return this.guard;
  }

  /**
   * Cancel everything: every command (follow, come, walk, kill, gather), a pending home return, a
   * guard fight and a flight. Returns what was running. (`!stop` keeps guard and flee running: it
   * uses `stopCommands()`.)
   */
  stop(): string {
    const was = this.behaviour();
    this.backHomeArmed = undefined; // Track M10
    this.processes.stopUser(['home']);
    this.guardProcess.cancelEpisode();
    this.fleeProcess.cancelEpisode();
    return was;
  }

  /** `!stop`: every command and what it pre-empted, plus a pending home return; guard, flee and night keep running. */
  stopCommands(): string {
    this.fleeFlight?.cancel(); // Track M3: the owner's !stop ends an elytra flee too (in the air it lands)
    const lines = this.processes.stopUser(['home']);
    return lines.length ? lines.join(', ') : this.behaviour();
  }

  /** On death: drop the commands that do not survive it (gather does), the episodes and a home return (guard settings stay). */
  onDeath(): void {
    this.processes.onDeath(['home']);
    this.backHomeArmed = undefined; // Track M10
    this.guardProcess.cancelEpisode();
    this.fleeProcess.cancelEpisode();
  }

  /** Follow a player (by name) or an entity (by runtime id) until stopped. */
  follow(target: FollowTarget, o: { urgent?: boolean } = {}): string {
    const label = 'playerName' in target ? target.playerName : `${bareType(this.d.world.entities.get(target.runtimeId)?.type ?? 'entity')} #${target.runtimeId}`;
    this.processes.add(new FollowProcess(this, target, label, o.urgent ?? false));
    return label;
  }

  /** Walk to within 2 blocks of the player's current position (eating first when the trip is long and food or health is low). */
  come(name: string, o: { urgent?: boolean } = {}): Promise<SkillResult> {
    return this.processes.add(new ComeProcess(this, name, o.urgent ?? false)).result;
  }

  /** goto as a user process: survives pre-emption (planned again afterwards); a walk of more than 16 blocks prepares first (Track W). */
  walk(goal: Goal, opts: GotoOptions = {}, label?: string): Promise<SkillResult> {
    return this.processes.add(new TripGotoProcess(this, { goal, opts, ...(label ? { label } : {}), mover: this.mover, position: () => this.position(), sprint: () => this.settings.get('sprint') })).result;
  }

  // ---- trip readiness (Track W, tasks/process/readiness.ts) ---------------------------------------

  /** Food from the world model (20 when the model has none). */
  food(): number {
    return this.d.world.self.food ?? 20;
  }

  /** Time of day from the night clock, when known. */
  timeOfDay(): number | undefined {
    const t = this.d.night?.status?.().timeOfDay;
    return typeof t === 'number' ? t : undefined;
  }

  /** Feet of a player by name: the tracked entity, else the locator bar's position (far players). */
  playerFeet(name: string): Vec3 | undefined {
    return this.trackedPlayerFeet(name) ?? this.locator.find(name)?.feet;
  }

  /**
   * Feet of a player tracked as an entity (within about 75 blocks), unless the locator bar has a newer
   * position (an entity the server stopped updating after a teleport stays in the model).
   */
  trackedPlayerFeet(name: string): Vec3 | undefined {
    const n = name.toLowerCase();
    const far = this.locator.find(name);
    for (const e of this.d.world.entities.values()) {
      if (e.username?.replace(/§./g, '').toLowerCase() !== n) continue;
      if (far && far.at > e.updatedAt && dist(far.feet, entityFeet(e)) > 4) return undefined;
      return entityFeet(e);
    }
    return undefined;
  }

  /** The command-time check: refuse at night without a chestplate (unless `now`), and whether it will eat first. */
  tripCheck(cmd: string, to: Vec3 | undefined, now: boolean): TripCheck {
    const inv = this.d.world.inventory;
    const worn = this.kit?.()?.armour.worn() ?? inv.window(120)?.slots ?? [];
    return checkTrip({ cmd, self: { food: this.food(), health: this.health() }, timeOfDay: this.timeOfDay(), worn, slots: inv.slots, long: longTrip(this.position(), to), now });
  }

  /** Food or health is below 14 and the kit is there to fix it. */
  prepNeeded(to: Vec3 | undefined): boolean {
    if (!longTrip(this.position(), to)) return false;
    return (this.kit?.() !== undefined && needsPrep({ food: this.food(), health: this.health() })) || this.tripStocks.some((s) => s.needed(to)); // Track K1: milk; Track R9: rockets
  }

  /** Add a stock step to the trip readiness (Track K1 milk, Track R9 rockets); `removeTripStock` takes it out again. */
  addTripStock(s: TripStock): void {
    if (!this.tripStocks.includes(s)) this.tripStocks.push(s);
  }

  removeTripStock(s: TripStock): void {
    const i = this.tripStocks.indexOf(s);
    if (i >= 0) this.tripStocks.splice(i, 1);
  }

  /**
   * Eat to full and put on armour (see readiness.ts), then the stock steps (Track K1 milk, Track R9 rockets; `to`: the
   * trip's goal); resolves at once when there is nothing to do.
   */
  async prepare(alive: () => boolean, phase: (p: PrepPhase) => void, to?: Vec3): Promise<void> {
    const kit = this.kit?.();
    if (kit && needsPrep({ food: this.food(), health: this.health() })) {
      const self = { food: this.food(), health: this.health() };
      Object.defineProperties(self, { food: { get: () => this.food() }, health: { get: () => this.health() } });
      const loop = this.d.loop;
      const r = await prepareTrip(kit, self, { alive, phase, wait: (n) => (loop.waitTicks ? loop.waitTicks(n) : new Promise((res) => setTimeout(res, n * 50))) });
      this.log.info(`trip: prepared (${r.bites} bites, food ${r.foodBefore} -> ${r.foodAfter}${r.equipped.length ? `, wearing ${r.equipped.join(', ')}` : ''}; ${r.stop})`);
    }
    // Track K1: the milk buckets missing to milkKeep, out of the carried boxes and the chests at home; Track R9: rockets
    for (const stock of [...this.tripStocks]) {
      if (!alive() || !stock.needed(to)) continue;
      phase(stock.name);
      await stock.run(alive);
    }
  }

  /** A goto process (not added) with this controller's mover and position. */
  gotoProcess(goal: Goal, opts: GotoOptions = {}, label?: string): GotoProcess {
    return new GotoProcess({ goal, opts, ...(label ? { label } : {}), mover: this.mover, position: () => this.position(), sprint: () => this.settings.get('sprint') });
  }

  /**
   * Walk home as the low-priority home-return process (after a guard fight, at dawn, after a
   * respawn). `ifIdle`: only when no command is queued. Resolves `no_home` without a home point.
   */
  returnHome(why: string, opts: { timeoutTicks?: number; ifIdle?: boolean } = {}): Promise<SkillResult> {
    const home = this.d.home();
    if (!home) return Promise.resolve({ ok: false, reason: 'no_home' });
    if (opts.ifIdle && this.processes.userProcesses().length > 0) return Promise.resolve({ ok: false, reason: 'busy' });
    for (const p of this.processes.find('home')) this.processes.stop(p, 'replaced');
    this.log.info(`${why}: returning home to ${home.x} ${home.y} ${home.z}`);
    const p = new GotoProcess({
      goal: { type: 'block', p: home },
      opts: { timeoutTicks: opts.timeoutTicks ?? 6000 },
      label: 'returning home',
      name: 'home',
      kind: 'auto',
      priority: PRIORITY.home,
      mover: this.mover,
      position: () => this.position(),
      sprint: () => this.settings.get('sprint'),
      skipWithin: 1.0,
    });
    return this.processes.add(p).result;
  }

  /** Kill up to `n` mobs of `type` within 32 blocks, nearest first. Refuses players. */
  kill(type: string, n: number, o: { urgent?: boolean } = {}): Promise<KillResult> {
    if (refusedKillType(type, this.d.world.entities)) {
      return Promise.resolve({ ok: false, type, killed: 0, want: n, reason: 'refused_player', fights: [] });
    }
    const p = this.processes.add(new KillProcess(this, type, n, o.urgent ?? false));
    this.guardProcess.cancelEpisode(); // an explicit kill replaces a guard fight (guard waits while a kill job exists)
    return p.result;
  }

  // ---- rules -----------------------------------------------------------------------------------

  /**
   * Low health: below fleeHealth (and alive). The health itself, not what the poison will leave (Track M4): with the poison
   * counted here and a witch fled from at home, the stone kit fled from the witch who poisoned it in 4 of 5 `mixed-8` runs
   * (1 of 5 before), she walked after it at 12 to 15, and her harming killed it at 1 health 100 blocks out in 2 of 5 (0 of 5
   * before). The poison stops at 1; the duel's margin still counts it (canDuel).
   */
  low(): boolean {
    return this.health() > 0 && this.health() < this.fleeHealth;
  }

  /**
   * Track M4 (`poison`): the health once the poison on the bot has done what it still will (it stops at 1); the health
   * itself without poison or with the rule off. On the gauntlet a witch's potion took the stone kit from 16 to 1 in 20 s
   * while it fought on (the duel rule judged 9 health enough for two skeletons), and the next arrow killed it.
   */
  healthAfterPoison(): number {
    const h = this.health();
    if (!this.rules.poison) return h;
    return h - poisonLeft(this.mobs.selfPoison, performance.now(), h);
  }

  nearestHostile(me: Vec3, r: number): EntityInfo | undefined { return targeting.nearestHostile(this, me, r); } // Track V: skills/combat/targeting.ts

  /** Hostiles, plus neutral mobs that hit or target the bot. Never players, items or passive mobs. */
  isThreat(e: EntityInfo): boolean { return targeting.isThreat(this, e); } // Track V

  /** The guard target, if any: reachability-aware, creepers first (skills/combat/targeting.ts). */
  pickThreat(me: Vec3, low: boolean): { e: EntityInfo; inPlace: boolean } | undefined { return targeting.pickThreat(this, me, low); } // Track V

  /** Track W hook: a creeper within 8 blocks below health 10 wants a flight (the bot does not engage it). */
  wantsFlee(threat: EntityInfo): boolean { return targeting.wantsFlee(this, threat); } // Track V

  /**
   * Where a flight may end (Track W): the shelter, else home, unless the bot is already there (within
   * 2 blocks). `kind` is 'shelter' or 'home'. undefined = nowhere to go (run away only).
   */
  fleeTarget(me: Vec3): { to: Vec3; kind: string } | undefined {
    const shelter = this.d.shelter();
    const home = this.d.home();
    const dest = shelter ?? home;
    if (!dest) return undefined;
    const c = { x: dest.x + 0.5, y: dest.y, z: dest.z + 0.5 };
    return Math.hypot(c.x - me.x, c.z - me.z) > 2 ? { to: dest, kind: shelter ? 'shelter' : 'home' } : undefined;
  }

  /** At the shelter / home already (within 2 blocks). */
  atFleeDest(me: Vec3): boolean {
    const dest = this.d.shelter() ?? this.d.home();
    return dest !== undefined && Math.hypot(dest.x + 0.5 - me.x, dest.z + 0.5 - me.z) <= 2 && Math.abs(dest.y - me.y) < 2;
  }

  /**
   * Track M4 (`archerDuel`): the archer to close in on instead of standing still at home, if any. With a blade, below
   * fleeHealth, within ARCHER_DUEL_HOME of home (no shelter: a shelter's walls stop arrows), only archers within FLEE_SCAN
   * (DUEL_ARCHERS_MAX at most, no melee mob, no creeper, no witch) and one of them with a line on the bot. The case: the stone
   * kit's `skeleton-4` at night killed three and stood at home at 6 to 7 health while the last one shot it dead from 10 to 15
   * (no flee: the threat was farther than 6 from home; no duel: 2 x the last hit was more than the health; guard in place at
   * low health does not walk to an archer). Standing still in an archer's line is the one choice that is sure to lose.
   */
  archerDuelTarget(me: Vec3): EntityInfo | undefined {
    if (!this.rules.archerDuel || !this.low() || !this.hasBlade() || this.d.shelter()) return undefined;
    // not with one arrow left (or the poison's 1): then the flight on foot, which `shooterHome` keeps from home
    if (this.healthAfterPoison() <= ARCHER_DUEL_MIN) return undefined;
    const home = this.d.home();
    if (!home || Math.hypot(home.x + 0.5 - me.x, home.z + 0.5 - me.z) > ARCHER_DUEL_HOME) return undefined;
    const grid = targeting.gridOf(this.mover);
    const eye = { x: me.x, y: me.y + 1.62, z: me.z };
    let best: EntityInfo | undefined;
    let bd = Infinity;
    let archers = 0;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const d = dist(entityFeet(e), me);
      if (d > FLEE_SCAN) continue;
      if (!DUEL_ARCHERS.has(bareType(e.type))) return undefined; // anything else near: the floors as they were
      if (++archers > DUEL_ARCHERS_MAX) return undefined;
      if (grid && !targeting.lineOfSight(grid, eye, e)) continue;
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  /** Track M1 round 2: a live threat within r other than `except` (the one just killed: it is listed for its death animation). */
  otherThreatWithin(me: Vec3, r: number, except: bigint): boolean {
    for (const e of this.d.world.entities.values()) {
      if (e.runtimeId === except || !this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      if (dist(entityFeet(e), me) <= r) return true;
    }
    return false;
  }

  /** Feet of every threat within r of `me`. */
  threatsNear(me: Vec3, r: number): Vec3[] {
    const out: Vec3[] = [];
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e)) continue;
      const f = entityFeet(e);
      if (dist(f, me) <= r) out.push(f);
    }
    return out;
  }

  /**
   * Track M1: the distance that counts for "clear to eat": the nearest threat, and 0 while a ranged mob is within
   * FLEE_SCAN (an archer or a witch hits from 8 to 15: a bite in its range is a free target; the bare gauntlet's
   * skeletons and witch hit the bot through the eat floor's bites). Only for a bot with no blade: in the kit the bites
   * are worth an arrow (the live kit's mixed 8 died once with no bite while a witch was near).
   */
  eatClearance(me: Vec3, nearest: number): number {
    if (this.hasBlade()) return nearest;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || !FLEE_RANGED.has(bareType(e.type))) continue;
      if (dist(entityFeet(e), me) <= FLEE_SCAN) return 0;
    }
    return nearest;
  }

  private idleBlocking = false;
  /**
   * Track M1 round 2: the shield while nothing runs. Two of the live kit's mixed 8 deaths (round 2) were a bot at home at 1
   * health (the witch's poison stops there), no process running (guard in place does not chase an archer at 10, a flight does
   * not start at home for a threat farther than 6), shot by a skeleton for 10 s with the shield in the offhand and never
   * raised (the fight raises it, nothing else did). So with the reflex on, nothing running, nothing walking or fighting: when
   * an archer's shot is due or an arrow flies at the bot (ShieldController.threat), face it and raise the shield (sneak);
   * lower it once that is over. The shield blocked 8 of 8 arrows from a skeleton at 8 (pve-rules `strike`).
   */
  private potionStepping: { ticks: number; id: bigint } | undefined;
  private readonly potionsStepped = new Set<bigint>();
  private potionPos = new Map<bigint, Vec3>();
  /** Side steps from a witch's potion so far (the PvE status). */
  potionSteps = 0;
  /**
   * Track M1 round 2: out from under a witch's potion. With the reflex killing the melee mobs where they stand, the bot stood
   * still while she threw: her poison (it takes the health down to 1) landed in 9 of 13 live-kit mixed 8 runs against 6 of 15
   * with the reflex off (round 2). A side step at each throw puts the potion 3.7 blocks off and halves it (measured). With
   * `mobReflex` on, on the ground, no walk and no process but guard (a guard fight is overridden for the step), a splash or
   * lingering potion within 12 (level) whose flight points at the bot gets a sprint at right angles to it, on safe cells only
   * (dodge.ts potionSideStep), for POTION_STEP_TICKS at most; it stops at once when a walk or another process starts.
   */
  private potionStep(): void {
    const loop = this.d.loop;
    // a fight's own steering and guard's approach walk run earlier in the tick (the combat skill's and the navigator's
    // handlers are older), so the step's command wins for its 12 ticks and they take over again after (the navigator
    // re-plans from where the body is); a walk of any other process keeps the keys (a user's goto is never pushed off)
    const keysFree = (): boolean => {
      const p = this.processes.active;
      return p ? p === this.guardProcess : !this.mover.nav.busy;
    };
    const on = this.settings.get('mobReflex') && !this.d.inactive() && loop.state.ready && this.health() > 0;
    if (this.potionStepping) {
      const s = this.potionStepping;
      if (!on || !keysFree() || --s.ticks <= 0 || !this.d.world.entities.has(s.id)) {
        this.potionStepping = undefined;
        if (keysFree()) loop.release();
      }
      return;
    }
    const me = loop.state.pos;
    // where each potion was last tick: its motion (the entity's own velocity is not kept up for a projectile)
    const last = this.potionPos;
    this.potionPos = new Map();
    for (const e of this.d.world.entities.values()) {
      const t = bareType(e.type);
      if (t === 'splash_potion' || t === 'lingering_potion') this.potionPos.set(e.runtimeId, { x: e.pos.x, y: e.pos.y, z: e.pos.z });
    }
    if (!on || !loop.state.onGround || !keysFree()) return;
    // Track M2: no step while guard fights the witch: the step takes the keys from the approach for 12 ticks a throw and she
    // lives longer. Live kit, mixed 8, 20 runs a side: potions within 4 of the bot 43 of 48 with the reflex (and the step) on,
    // 20 of 52 off; the witch's damage 22.7 a run on, 15.0 off
    if (this.processes.active === this.guardProcess && this.guardProcess.fighting === 'witch') return;
    for (const e of this.d.world.entities.values()) {
      const t = bareType(e.type);
      if ((t !== 'splash_potion' && t !== 'lingering_potion') || this.potionsStepped.has(e.runtimeId)) continue;
      const prev = last.get(e.runtimeId);
      const vx = prev ? e.pos.x - prev.x : e.vel.x;
      const vz = prev ? e.pos.z - prev.z : e.vel.z;
      // level only: a thrown potion first flies up (in 3D it points at the bot only in its last ticks)
      const dx = me.x - e.pos.x;
      const dz = me.z - e.pos.z;
      const d = Math.hypot(dx, dz);
      const sp = Math.hypot(vx, vz);
      if (d > 12 || d < 1 || sp < 0.05 || (vx * dx + vz * dz) / (sp * d) <= POTION_AIM_COS) continue;
      const vel = { x: vx, y: 0, z: vz };
      this.potionsStepped.add(e.runtimeId);
      if (this.potionsStepped.size > 64) this.potionsStepped.clear();
      const melee = this.nearestOfKind(me, 6, (tt) => tt !== 'witch' && !DUEL_ARCHERS.has(tt));
      const step = potionSideStep({ me, potion: e.pos, vel, avoid: melee ? entityFeet(melee) : undefined, grid: targeting.gridOf(this.mover) });
      if (!step) continue;
      this.potionStepping = { ticks: POTION_STEP_TICKS, id: e.runtimeId };
      this.potionSteps++;
      this.d.metrics?.inc('pve.reflex.potionSteps');
      if (this.idleBlocking) this.idleBlocking = false;
      loop.setCommand({ yaw: step.yaw, pitch: 0, forward: 1, strafe: 0, sprint: true, jump: false, sneak: false });
      this.log.info(`reflex: side step from a potion (${d.toFixed(1)} away)`);
      return;
    }
  }

  /** Track M10 (`backHome`): armed by a flight on foot from near home (when the last one started), undefined when not. */
  backHomeArmed: { at: number } | undefined;
  private backHomeTick = 0;
  private backHomeSaid: string | undefined;
  /** Track M10: walks home started by `backHome` so far (the PvE status, the gauntlet). */
  backHomes = 0;

  /** Track M10 (`backHome`): a flight on foot starts at `me`: arm the way back when it starts near home with no blade carried. */
  noteFlightStart(me: Vec3): void {
    if (!this.rules.backHome || this.carriesBlade()) return;
    const home = this.d.home();
    if (!home) return;
    if (this.backHomeArmed || Math.hypot(home.x + 0.5 - me.x, home.z + 0.5 - me.z) <= BACK_HOME_ARM) this.backHomeArmed = { at: performance.now() };
  }

  /**
   * Track M10 (`backHome`): every BACK_HOME_EVERY ticks while armed: home reached, a death or a command disarm it; with
   * nothing running and backHomeBlock clear, the home return walks the bot back (a flight that pre-empts it arms again).
   */
  private backHomeStep(): void {
    if (++this.backHomeTick % BACK_HOME_EVERY !== 0) return;
    const armed = this.backHomeArmed;
    if (!armed) return;
    const home = this.d.home();
    if (!this.rules.backHome || !home || this.health() <= 0 || performance.now() - armed.at > BACK_HOME_MS || this.processes.userProcesses().length > 0) {
      if (this.rules.backHome && home && this.health() > 0) this.log.info(`flee: not home: ${this.processes.userProcesses().length > 0 ? 'a command runs' : `${BACK_HOME_MS / 60_000} min since the flight`}`);
      this.backHomeArmed = undefined;
      this.backHomeSaid = undefined;
      return;
    }
    if (this.d.inactive() || !this.d.loop.state.ready) return;
    // a flight, a fight, a job: looked at again once it ends (and the flight that armed it starts at home: not "home again")
    if (this.processes.active) return;
    const me = this.position();
    if (Math.hypot(home.x + 0.5 - me.x, home.z + 0.5 - me.z) <= BACK_HOME_AT) {
      this.backHomeArmed = undefined;
      this.backHomeSaid = undefined;
      return;
    }
    const wait = this.processes.find('home').length > 0 ? 'a walk home already queued' : this.flyHandover() ? 'the elytra flee' : this.d.night?.wantsShelter() ? 'the night shelter' : undefined;
    if (wait) {
      if (wait !== this.backHomeSaid) this.log.info(`flee: not home yet: ${wait}`);
      this.backHomeSaid = wait;
      return;
    }
    let melee = 0;
    let shooter = false;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const t = bareType(e.type);
      const d = dist(entityFeet(e), me);
      if (DUEL_ARCHERS.has(t) || t === 'witch') shooter ||= d <= FLEE_SCAN;
      else if (d <= FLEE_SCAN + 8) melee++;
    }
    const why = backHomeBlock({ melee, shooter, homeShot: this.shooterNear(home, SHOOTER_HOME), wayShot: this.shooterOnWay(me, home, SHOOTER_WAY) });
    if (why) {
      if (why !== this.backHomeSaid) this.log.info(`flee: not home yet: ${why}`);
      this.backHomeSaid = why;
      return;
    }
    this.backHomeArmed = undefined;
    this.backHomeSaid = undefined;
    this.backHomes++;
    this.d.metrics?.inc('pve.backHome');
    void this.returnHome('flee: nothing near', { timeoutTicks: 6000, ifIdle: true });
  }

  /** Track M7 (`milkCure`): a drink is under way, and the tick count (checked every CURE_EVERY ticks). */
  private curing = false;
  private cureTick = 0;
  /** Track M7: milk drunk against the poison so far (the PvE status). */
  cures = 0;
  /**
   * Track M7 (`milkCure`): the witch's poison is 1 health every 25 ticks for up to 45 s and stops at 1, whatever the armour:
   * on the live kit's night `mixed-8` it was 17.4 of the 21.6 damage a run, and the health went under 6 in 10 of 15 runs, 7 of
   * them standing at home after the last fight with the poison still on (2026-11-16). A milk bucket clears every effect in
   * one drink (32 ticks). So with milk carried: drink once the poison would still take more than CURE_MIN_LOSS, no live
   * witch within CURE_WITCH_CLEAR (she throws poison at a bot that is not poisoned), every mob FLEE_EAT_CLEAR away (the eat
   * floor's rule: a drink slows the body like a bite), not in a fight or a flight. Without milk nothing happens.
   */
  wantsCure(me: Vec3): boolean {
    if (!this.rules.milkCure || this.health() <= 0) return false;
    const p = this.mobs.selfPoison;
    if (!p || performance.now() >= p.until) return false;
    if (this.health() - this.healthAfterPoisonAlways() <= CURE_MIN_LOSS) return false;
    if (!this.d.world.inventory.slots.slice(0, 36).some((it) => it?.name === CURE_ITEM && it.count > 0)) return false;
    if (this.nearestOfKind(me, CURE_WITCH_CLEAR, (t) => t === 'witch')) return false;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      if (dist(entityFeet(e), me) < FLEE_EAT_CLEAR) return false;
    }
    return true;
  }

  /** Track M7: the health the poison will leave, counted whatever the `poison` rule (the cure's own reading). */
  private healthAfterPoisonAlways(): number {
    const h = this.health();
    return h - poisonLeft(this.mobs.selfPoison, performance.now(), h);
  }

  private cureStep(): void {
    if (this.curing || ++this.cureTick % CURE_EVERY !== 0) return;
    const kit = this.kit?.();
    // not in a fight (its strikes reselect the blade and the drink stops) nor in an elytra flight
    if (!kit?.drink || !this.d.loop.state.ready || this.d.inactive() || this.combat.busy || this.processes.active?.name === 'flight' || this.fleeFlight?.active() === true) return;
    const me = this.position();
    if (!this.wantsCure(me)) return;
    const h = this.health();
    const left = ((this.mobs.selfPoison?.until ?? 0) - performance.now()) / 1000;
    this.curing = true;
    this.log.info(`pve: drinking milk against the poison (${left.toFixed(0)} s left, health ${h.toFixed(1)}, ${this.healthAfterPoisonAlways().toFixed(1)} once it ends)`);
    void kit
      .drink(CURE_ITEM)
      .then((r) => {
        if (r.ok) {
          this.cures++;
          this.d.metrics?.inc('pve.cure');
          this.mobs.selfPoison = undefined; // the server's mob_effect remove follows; the cure is not drunk twice meanwhile
        }
        this.log.info(`pve: milk ${r.ok ? 'drunk: the poison is gone' : `not drunk (${r.reason ?? '?'})`}, health ${this.health().toFixed(1)}`);
      })
      .catch(() => undefined)
      .finally(() => {
        this.curing = false;
      });
  }

  private idleBlock(): void {
    if (this.potionStepping) return;
    const loop = this.d.loop;
    const idle = this.settings.get('mobReflex') && !this.d.inactive() && loop.state.ready && !this.processes.active && !this.mover.nav.busy && !this.combat.busy && this.health() > 0;
    const t = idle && this.combat.shield.equipped() ? this.combat.shield.threat(loop.state.pos) : undefined;
    if (t) {
      const me = loop.state.pos;
      loop.setCommand({ yaw: (Math.atan2(-(t.from.x - me.x), t.from.z - me.z) * 180) / Math.PI, pitch: 0, forward: 0, strafe: 0, sprint: false, jump: false, sneak: true });
      if (!this.idleBlocking) this.log.info(`shield: raised while idle (${t.why === 'arrow' ? 'an arrow coming' : `${t.e ? bareType(t.e.type) : 'an archer'}'s shot due`})`);
      this.idleBlocking = true;
    } else if (this.idleBlocking) {
      this.idleBlocking = false;
      loop.setCommand({ sneak: false });
    }
  }

  /**
   * Track M2: hold the ground (holdGround): the reflex able, 1 to HOLD_MAX melee mobs within HOLD_RANGE, no creeper within
   * FLEE_CREEPER_RANGE and no archer or witch within FLEE_SCAN in sight, fewer than 2 melee hits in HOLD_HITS_MS.
   */
  /** The reflex is on and able: `mobReflex`, the bot active and in the world, not in a flight. */
  reflexOn(): boolean {
    return this.settings.get('mobReflex') && !this.d.inactive() && this.d.loop.state.ready && this.processes.active?.name !== 'flight';
  }

  holds(me: Vec3): boolean {
    if (!this.reflexOn()) return false;
    const grid = targeting.gridOf(this.mover);
    const eye = { x: me.x, y: me.y + 1.62, z: me.z };
    let melee = 0;
    let other = false;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const d = dist(entityFeet(e), me);
      if (bareType(e.type) === 'creeper') {
        if (d <= FLEE_CREEPER_RANGE) other = true;
      } else if (targeting.isMelee(e, this.mobs)) {
        if (d <= HOLD_RANGE) melee++;
      } else if (d <= FLEE_SCAN && (!grid || targeting.lineOfSight(grid, eye, e))) other = true;
    }
    const now = performance.now();
    const meleeHits = this.meleeHitTimes.filter((t) => now - t < HOLD_HITS_MS).length;
    return holdGround({ reflex: true, melee, other, meleeHits });
  }

  /** Track M1: a sword or an axe in the hotbar. */
  hasBlade(): boolean {
    return this.d.world.inventory.slots.slice(0, 9).some((it) => !!it && it.count > 0 && bladeScore(it) > 0);
  }

  /**
   * A blade anywhere in the inventory, the hotbar or the main slots (`bareArcher`): the fight fetches a blade from the
   * main slots before its first strike (Track T2), so a sword out of the hotbar is not "no blade". On the Realm
   * (2026-11-17, `!test mobs skeleton 5 bare`, the sword in a main slot, netherite worn) the hotbar-only check fled from
   * one skeleton at 20 health and cleared 0 of 5, where the same series cleared 5 of 5 before.
   */
  carriesBlade(): boolean {
    return this.d.world.inventory.slots.some((it) => !!it && it.count > 0 && bladeScore(it) > 0);
  }

  /** Track M5 (`witchCrowd`): when its line was last said (at most every 30 s). */
  private crowdSaidAt = -Infinity;

  /** Track M5: the best blade's score in the hotbar (combat.ts bladeScore; 0 with none). */
  bestBlade(): number {
    let best = 0;
    for (const it of this.d.world.inventory.slots.slice(0, 9)) if (it && it.count > 0) best = Math.max(best, bladeScore(it));
    return best;
  }

  /**
   * Track M1: the witch goes first (guard's rank, targeting.ts firstTarget). Measured on BDS (ADR 0079): her harming potion is
   * 6 whatever the armour, her poison 1 every 25 ticks for 45 s, a throw every 61 ticks from 8 blocks (none from 12, held in
   * place), and the netherite sword kills her in 3 hits, 1.7 s from 5 blocks (sprint hits the same, critical hits 2.1 s). So
   * with a blade, at WITCH_ENGAGE_HEALTH or more (one potion on the way still leaves health), within WITCH_FIRST_RANGE, in
   * sight, and the way to her clear of other melee mobs (none within WITCH_WAY_CLEAR of the line beyond the bot's own reach).
   */
  firstTarget(e: EntityInfo, me: Vec3): boolean {
    // Track M4: the archer at home is fought with the approach, also at low health (archerDuelTarget)
    if (DUEL_ARCHERS.has(bareType(e.type))) return this.rules.archerDuel && this.archerDuelTarget(me)?.runtimeId === e.runtimeId;
    if (bareType(e.type) !== 'witch' || this.mobs.get(e.runtimeId)?.dead || !this.hasBlade()) return false;
    const f = entityFeet(e);
    const d = dist(f, me);
    if (d > WITCH_FIRST_RANGE) return false;
    // Track M5 (`witchCrowd`): not with an archer shooting and one throw and one arrow from dead. In the stone kit's seal-5
    // deaths at home (2 of 4 on main, 2026-11-16) guard fought her at 7 to 10 health with two skeletons at 8 to 12 in sight;
    // her harming took it to 1 to 4 and the next arrow killed it
    // (a diamond or netherite sword kills her in 3 hits, under 2 s: on the live kit's mixed-8 the rule took the lowest
    // health's median from 5.3 to 1.4, 5 runs a side)
    if (this.rules.witchCrowd && this.health() <= WITCH_CROWD_HEALTH && this.bestBlade() < WITCH_CROWD_BLADE && this.shootersWithin(me, FLEE_SCAN, false) > 0) {
      if (performance.now() - this.crowdSaidAt > 30_000) {
        this.crowdSaidAt = performance.now();
        this.log.info(`guard: the witch is not first at health ${this.health().toFixed(1)} with an archer shooting (her harming and one arrow are the health)`);
      }
      return false;
    }
    // Within WITCH_CLOSE (her throw range) at any health: a run does not get out of her range before her next throw (she
    // follows; three round-2 mixed-8 deaths ran from her at 6 to 7 blocks and 3 to 7 health, her one hit from dead, and her
    // harming came from 9 to 11). Farther, at low health, only just after a throw: she cannot throw again for about 3 s
    if (d > WITCH_CLOSE && this.health() < WITCH_ENGAGE_HEALTH && !this.witchJustThrew(e.runtimeId)) return false;
    const grid = targeting.gridOf(this.mover);
    if (grid && !targeting.lineOfSight(grid, { x: me.x, y: me.y + 1.62, z: me.z }, e)) return false;
    const len = Math.hypot(f.x - me.x, f.z - me.z);
    if (len < 1e-3) return true;
    // Track M2: with the reflex on, the melee mobs on the way are struck in passing, so the way need not be clear. With the
    // way rule the reflex kept the bot at home killing the ring while she threw at a still body: live mixed-8, 30 runs a side,
    // potions within 4 of the bot 54 of 62 on against 26 of 72 off, the witch's damage 20.5 against 14.9
    if (this.reflexOn()) return true;
    const ux = (f.x - me.x) / len;
    const uz = (f.z - me.z) / len;
    for (const o of this.d.world.entities.values()) {
      if (o.runtimeId === e.runtimeId || !this.isThreat(o) || !targeting.isMelee(o, this.mobs)) continue;
      const g = entityFeet(o);
      const rx = g.x - me.x;
      const rz = g.z - me.z;
      const along = rx * ux + rz * uz;
      if (along < 0 || along > len || Math.hypot(rx, rz) <= WITCH_WAY_OWN) continue;
      if (Math.abs(rx * uz - rz * ux) <= WITCH_WAY_CLEAR) return false;
    }
    return true;
  }

  /**
   * Track M7 (`witchRush`): guard's fight on `e` rushes her (FightOptions.rush): a witch it fights first (firstTarget), a
   * diamond or netherite sword in the hotbar (WITCH_CROWD_BLADE: three hits, under 2 s), the reflex on (it strikes the mobs
   * in reach while the fight does not re-pick them). On the live kit's night `mixed-8` (2026-11-16, 15 runs) the fight had
   * her from tick 0 to 14 and she threw first at tick 57 to 80, but she died at tick 195 to 430: the creeper in between
   * (60 to 135 ticks of hit and run), a re-pick to a spider in reach, and the shield raised for the skeleton (a sneak: the
   * body crept at 4 to 5 from her) let her throw, and her poison was 17.4 of the 21.6 damage a run.
   */
  witchRushes(e: EntityInfo, me: Vec3): boolean {
    if (!this.rules.witchRush || bareType(e.type) !== 'witch' || !this.reflexOn()) return false;
    if (this.bestBlade() < WITCH_CROWD_BLADE) return false;
    return this.firstTarget(e, me);
  }

  /**
   * Track E12 (`workGuard`): with guard off and a job at work (a user process not in WORK_GUARD_SKIP, no kill job, not
   * held by !pause), the shooter for guard's fight, if any. A witch the bot fights first (firstTarget: a blade, her range,
   * the health, a line on her; within FIRST_MAX_DY): with guard off the flee leaves her alone for that same rule, so
   * nobody fought her and she threw at the work (the witch scene: 26 to 29 damage, lowest 1, 0 fights). Else, at
   * WORK_ARCHER_HEALTH or more, the nearest archer within WORK_ARCHER_RANGE and MAX_DY with a line on the bot that aims
   * at it or hit it in the last 10 s, while it is the only archer there (WORK_ARCHERS_MAX). Mobs guard ignores stay
   * ignored, but for the held witch (Track M11, heldWorkWitch): she is fought again WORK_WITCH_REFIGHT_MS after a fight on
   * her ended.
   */
  workThreat(me: Vec3): EntityInfo | undefined {
    if (!this.workGuardOn()) return undefined;
    const now = performance.now();
    const held = this.workWitch;
    const grid = targeting.gridOf(this.mover);
    const eye = { x: me.x, y: me.y + 1.62, z: me.z };
    let best: EntityInfo | undefined;
    let bs = Infinity;
    const archers = this.workArchers(me);
    for (const e of this.d.world.entities.values()) {
      const isHeld = held?.rid === e.runtimeId;
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      if (isHeld ? now - held.endedAt < WORK_WITCH_REFIGHT_MS : (this.ignore.get(e.runtimeId) ?? 0) > now) continue;
      const t = bareType(e.type);
      const f = entityFeet(e);
      const d = dist(f, me);
      let score: number;
      if (t === 'witch') {
        if (Math.abs(f.y - me.y) > targeting.FIRST_MAX_DY || !this.firstTarget(e, me)) continue;
        score = d - 500; // her first, as guard ranks her
      } else if (DUEL_ARCHERS.has(t)) {
        // Two archers or more: the fight on one left the other shooting (the archers scene: the same damage and lowest
        // health as with no fight, nothing mined, and a death once); the work and its flee rules go on as before.
        if (archers > WORK_ARCHERS_MAX || this.low() || this.health() < WORK_ARCHER_HEALTH) continue;
        if (d > WORK_ARCHER_RANGE || Math.abs(f.y - me.y) > targeting.MAX_DY) continue;
        const hitUs = this.mobs.hitUsWithin(e.runtimeId, 10_000);
        if (!hitUs && !this.mobs.targetsUs(e.runtimeId)) continue;
        if (grid && !targeting.lineOfSight(grid, eye, e)) continue;
        if (!targeting.reachability(grid, me, e)) continue;
        score = d - (hitUs ? 100 : 0);
      } else continue;
      if (score < bs) {
        bs = score;
        best = e;
      }
    }
    return best;
  }

  /** Track E12 / M11: workGuard can act: guard off, the setting on, not paused, a blade, a job at work and no kill job. */
  workGuardOn(): boolean {
    if (this.guardOn || !this.settings.get('workGuard') || this.processes.paused || !this.hasBlade()) return false;
    const users = this.processes.userProcesses();
    return !users.some((p) => p.name === 'kill') && users.some((p) => !WORK_GUARD_SKIP.has(p.name));
  }

  /**
   * Track M11 (`workGuard`): the held witch (workWitch) while the hold goes on: she is alive, within WORK_WITCH_HOLD_RANGE
   * or aiming at the bot, the first fight on her ended under WORK_WITCH_HOLD_MS ago, and workGuard can act. Otherwise the
   * hold ends (with a line) and undefined. Guard stands the work still while she is held and not fought (GuardProcess).
   */
  heldWorkWitch(me: Vec3): EntityInfo | undefined {
    const h = this.workWitch;
    if (!h) return undefined;
    const end = (why: string): undefined => {
      this.log.info(`guard: the hold on witch #${h.rid} ends: ${why} (workGuard, ${h.fights} fight(s), ${((performance.now() - h.since) / 1000).toFixed(1)} s)`);
      this.workWitch = undefined;
      return undefined;
    };
    if (!this.workGuardOn()) return end('no work to hold');
    const e = this.d.world.entities.get(h.rid);
    if (!e || this.mobs.get(h.rid)?.dead) return end('dead or gone');
    if (performance.now() - h.since > WORK_WITCH_HOLD_MS) return end(`held ${WORK_WITCH_HOLD_MS / 1000} s`);
    const d = dist(entityFeet(e), me);
    if (d > WORK_WITCH_HOLD_RANGE && !this.mobs.targetsUs(h.rid)) return end(`${d.toFixed(1)} off and not aiming`);
    return e;
  }

  /** Track M11: a fight for the work on witch `e` ended with `r`: killed ends the hold, anything else starts or keeps it. */
  workWitchFought(e: EntityInfo, r: FightResult): void {
    const now = performance.now();
    if (r.reason === 'killed' || this.mobs.get(e.runtimeId)?.dead) {
      this.workWitch = undefined;
      return;
    }
    const h = this.workWitch?.rid === e.runtimeId ? this.workWitch : { rid: e.runtimeId, since: now, endedAt: now, fights: 0, unreachable: 0 };
    h.endedAt = now;
    h.fights++;
    h.unreachable = r.reason === 'unreachable' ? h.unreachable + 1 : 0;
    if (h.unreachable >= WORK_WITCH_UNREACHABLE_MAX) {
      this.log.info(`guard: the fight for the work on witch #${e.runtimeId} ended unreachable ${h.unreachable} times in a row; no hold (workGuard, ${h.fights} fight(s))`);
      this.workWitch = undefined;
      return;
    }
    this.workWitch = h;
    this.log.info(`guard: the fight for the work on witch #${e.runtimeId} ended ${r.reason}; the work waits while she is within ${WORK_WITCH_HOLD_RANGE} (workGuard, fight ${h.fights})`);
  }

  /**
   * Track E12 (`workGuard`): the live archers within WORK_ARCHER_RANGE and MAX_DY of the bot, seen or not, aiming or not
   * (one in a hole the bot dug, or summoned a moment later, shoots as soon as the fight walks out).
   */
  workArchers(me: Vec3): number {
    let n = 0;
    for (const e of this.d.world.entities.values()) {
      if (!DUEL_ARCHERS.has(bareType(e.type)) || !this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const f = entityFeet(e);
      if (dist(f, me) <= WORK_ARCHER_RANGE && Math.abs(f.y - me.y) <= targeting.MAX_DY) n++;
    }
    return n;
  }

  /** Track M7 (targeting.ts pickThreat): while the probe of a witch to rush runs, guard starts no fight on a mob in reach. */
  firstWaits(e: EntityInfo, me: Vec3): boolean {
    return this.witchRushes(e, me);
  }

  /**
   * Track M1 round 2: the archers and witches within DODGE_RANGE with a line on the bot (skills/combat/dodge.ts), when the
   * dodge is for this bot now: `mobDodge` on, no blade, no melee mob within DODGE_MELEE. Empty otherwise.
   */
  dodgeShooters(me: Vec3): DodgeShooter[] {
    if (!this.settings.get('mobDodge') || this.hasBlade() || this.meleeWithin(me, DODGE_MELEE)) return [];
    const grid = targeting.gridOf(this.mover);
    const eye = { x: me.x, y: me.y + 1.62, z: me.z };
    const out: DodgeShooter[] = [];
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const t = bareType(e.type);
      const kind = DUEL_ARCHERS.has(t) ? 'archer' : t === 'witch' ? 'witch' : undefined;
      if (!kind) continue;
      const f = entityFeet(e);
      if (dist(f, me) > DODGE_RANGE) continue;
      if (grid && !targeting.lineOfSight(grid, eye, e)) continue;
      out.push({ pos: f, kind });
    }
    return out;
  }

  /** Track M1 round 2: when each witch last threw (performance.now ms), from the splash potions seen next to her. */
  private readonly witchThrow = new Map<bigint, number>();
  private readonly potionsSeen = new Set<bigint>();
  private noteWitchThrows(): void {
    let potions = 0;
    for (const p of this.d.world.entities.values()) {
      const t = bareType(p.type);
      if (t !== 'splash_potion' && t !== 'lingering_potion') continue;
      potions++;
      if (this.potionsSeen.has(p.runtimeId)) continue;
      this.potionsSeen.add(p.runtimeId);
      // a new potion: the witch within WITCH_THROW_NEAR of it threw it
      for (const w of this.d.world.entities.values()) {
        if (bareType(w.type) !== 'witch') continue;
        const f = entityFeet(w);
        if (Math.hypot(f.x - p.pos.x, f.y + 1.5 - p.pos.y, f.z - p.pos.z) <= WITCH_THROW_NEAR) this.witchThrow.set(w.runtimeId, performance.now());
      }
    }
    if (potions === 0 && this.potionsSeen.size > 0) this.potionsSeen.clear();
    if (this.witchThrow.size > 16) this.witchThrow.clear();
    if (++this.shooterTick % 10 === 0) this.noteShooters();
  }

  /**
   * Track M5 (`shooterWay`): the archers and witches the server stopped sending while they stood SHOOTER_LOST_FAR or more
   * from the bot (out of the range it sends entities in, not killed: a kill is near), kept SHOOTER_MEMORY_MS at their last
   * place. In a stone-kit `seal-5` death the bot waited 53 blocks out at 1 health, then walked home into a skeleton it had
   * no entity for (2026-11-16).
   */
  private readonly shooterSeen = new Map<bigint, { pos: Vec3; at: number; dist: number }>();
  private shooterTick = 0;
  private noteShooters(): void {
    const now = performance.now();
    const me = this.position();
    for (const e of this.d.world.entities.values()) {
      const t = bareType(e.type);
      if (!DUEL_ARCHERS.has(t) && t !== 'witch') continue;
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) {
        this.shooterSeen.delete(e.runtimeId);
        continue;
      }
      const f = entityFeet(e);
      this.shooterSeen.set(e.runtimeId, { pos: { ...f }, at: now, dist: dist(f, me) });
    }
    for (const [id, r] of this.shooterSeen) {
      if (this.d.world.entities.has(id)) continue;
      if (r.dist < SHOOTER_LOST_FAR || now - r.at > SHOOTER_MEMORY_MS) this.shooterSeen.delete(id);
    }
  }

  /** Track M5: where the archers and witches out of the server's range were last (shooterSeen). */
  rememberedShooters(): Vec3[] {
    const out: Vec3[] = [];
    const now = performance.now();
    for (const [id, r] of this.shooterSeen) if (!this.d.world.entities.has(id) && now - r.at <= SHOOTER_MEMORY_MS) out.push(r.pos);
    return out;
  }

  /** Track M1 round 2: this witch threw within WITCH_WINDOW_MS (her next throw is 61 ticks after the last). */
  witchJustThrew(id: bigint): boolean {
    const at = this.witchThrow.get(id);
    return at !== undefined && performance.now() - at <= WITCH_WINDOW_MS;
  }

  /** Track M1 round 2: an arrow or a splash potion in the air towards the bot (within 16, coming at it). */
  shotInFlight(me: Vec3): { any: boolean; ids: bigint[] } {
    const ids: bigint[] = [];
    let any = false;
    for (const e of this.d.world.entities.values()) {
      const t = bareType(e.type);
      if (t !== 'arrow' && t !== 'splash_potion' && t !== 'lingering_potion' && t !== 'thrown_trident') continue;
      const dx = me.x - e.pos.x;
      const dy = me.y + 1 - e.pos.y;
      const dz = me.z - e.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 16) continue;
      ids.push(e.runtimeId);
      const v = e.vel;
      const sp = Math.hypot(v.x, v.y, v.z);
      if (sp > 0.2 && (v.x * dx + v.y * dy + v.z * dz) / (sp * Math.max(d, 1e-3)) > 0.5) any = true;
    }
    return { any, ids };
  }

  /** Track M1: the nearest threat within r whose bare type passes `kind`. */
  nearestOfKind(me: Vec3, r: number, kind: (type: string) => boolean): EntityInfo | undefined {
    let best: EntityInfo | undefined;
    let bd = r;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || !kind(bareType(e.type))) continue;
      const d = dist(entityFeet(e), me);
      if (d <= bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  /** A live creeper within FLEE_CREEPER_RANGE. */
  creeperNear(_me: Vec3): EntityInfo | undefined {
    for (const e of this.d.world.entities.values()) {
      if (bareType(e.type) !== 'creeper' || this.mobs.get(e.runtimeId)?.dead) continue;
      if (targeting.wantsFlee(this, e)) return e; // Track V's rule (creeper within 8, health below 10): one rule for both sides
    }
    return undefined;
  }

  /**
   * Track E7 (`creeperReach`): the strike a reflex would make now (the blade strike's blade, else the held item: combat.ts
   * strikeDamage) is too weak to keep this creeper off (creeperStrikesEnough).
   */
  creeperStrikeWeak(e: EntityInfo): boolean {
    return !creeperStrikesEnough(this.mobs.get(e.runtimeId)?.health, strikeDamage(this.combat.strikeItem(this.rules.bladeStrike)));
  }

  /** Track E7: the creeper a back-off runs from (it holds until that creeper is FLEE_CREEPER_RANGE away or gone). */
  private creeperBackingFrom: bigint | undefined;

  /**
   * Track E7 (`creeperReach`): with guard off, the creeper to back off from now, if any: one within CREEPER_BLAST_REACH
   * whose fuse has burned CREEPER_LIT_BACKOFF ticks, or one within CREEPER_BACKOFF_RANGE while the strike is too weak.
   * Once backing off, until that creeper is FLEE_CREEPER_RANGE away (its fuse goes out at about 7) or gone. Not while
   * walled in (a night or smelt shell, a seal: running would dig out).
   */
  creeperBackOff(me: Vec3): EntityInfo | undefined {
    if (!this.rules.creeperReach || this.guardOn) {
      this.creeperBackingFrom = undefined;
      return undefined;
    }
    const alive = (e: EntityInfo | undefined): e is EntityInfo => e !== undefined && bareType(e.type) === 'creeper' && !this.mobs.get(e.runtimeId)?.dead;
    let best: EntityInfo | undefined;
    const from = this.creeperBackingFrom === undefined ? undefined : this.d.world.entities.get(this.creeperBackingFrom);
    if (alive(from) && dist(entityFeet(from), me) <= FLEE_CREEPER_RANGE) best = from;
    else {
      let bd = Infinity;
      for (const e of this.d.world.entities.values()) {
        if (!alive(e)) continue;
        const d = dist(entityFeet(e), me);
        if (d >= bd) continue;
        const lit = d <= CREEPER_BLAST_REACH && this.mobs.ticksLit(e.runtimeId) >= CREEPER_LIT_BACKOFF;
        const weak = d <= CREEPER_BACKOFF_RANGE && this.creeperStrikeWeak(e);
        if (!lit && !weak) continue;
        bd = d;
        best = e;
      }
    }
    // walled in: every cell round the feet and the head is solid; nothing walks up to the body
    if (best && walledIn(me, targeting.gridOf(this.mover))) best = undefined;
    this.creeperBackingFrom = best?.runtimeId;
    return best;
  }

  /**
   * Why the bot must flee now, if it must: `low` (health below fleeHealth with a hostile within 16) or
   * `creeper` (a creeper within 6 and health below 10, whatever fleeHealth says). At the shelter /
   * home a flight starts only when the threat is within 6 (inside, guard defends in place).
   */
  fleeReason(me: Vec3): { why: 'low' | 'creeper'; threat: EntityInfo; foot?: true } | undefined {
    const h = this.health();
    if (h <= 0) return undefined;
    let out: { why: 'low' | 'creeper'; threat: EntityInfo; foot?: true } | undefined;
    if (h < FLEE_CREEPER_HEALTH) {
      const cr = this.creeperNear(me);
      if (cr) out = { why: 'creeper', threat: cr };
    }
    // Track E7 (`creeperReach`): guard off, a creeper whose fuse burns on or that the strike in hand does not keep off: back off at any health
    if (!out) {
      const cr = this.creeperBackOff(me);
      if (cr) out = { why: 'creeper', threat: cr };
    }
    out ??= ((t) => (t ? { why: 'low' as const, threat: t } : undefined))(targeting.crowdThreat(this, me)); // Track AH: crowd rule (3+ melee within 4, health < 12), like a creeper
    // Track M2: up to HOLD_MAX melee mobs the reflex keeps out: stand and strike, do not run with the back turned
    if (out?.why === 'low' && this.holds(me)) out = undefined;
    // Track M1 round 2: a witch the bot fights first (firstTarget) is not run from at low health (she follows and throws)
    const witchFirst = !out && this.hasBlade() ? this.nearestOfKind(me, WITCH_FIRST_RANGE, (t) => t === 'witch') : undefined;
    if (witchFirst && this.firstTarget(witchFirst, me)) return undefined;
    // (Track M6, `volley`: also at fleeHealth or over when one round of the shooters in sight is the health)
    if (!out && (this.low() || this.volleyLow(me)) && !this.canDuel(me) && !this.holds(me)) {
      const t = this.nearestHostile(me, FLEE_SCAN);
      if (t) out = { why: 'low', threat: t };
    }
    // Track M6 (`bareArcher`): no blade and an archer with a line on the bot: the flight on foot at any health. At
    // FLY_SHOOTER_HEALTH or over it stays on foot (`foot`): the elytra flee's rule for shooters (Track M3) starts below it
    // and is not moved up (a takeoff costs rockets the Realm has to craft); below it the floors choose as before
    // (Track M9, `craftBlade`: not while a blade is crafted for it, or is about to be)
    if (!out && !(this.rules.craftBlade && (this.bladeProcess.busy() || this.bladeProcess.wants()))) {
      const a = this.bareArcher(me);
      if (a) out = h >= FLY_SHOOTER_HEALTH ? { why: 'low', threat: a, foot: true } : { why: 'low', threat: a };
    }
    // Track M1: a witch's harming potion is 6 at once on top of its poison: below WITCH_FLEE_HEALTH a bot with no blade
    // runs from a witch within FLEE_SCAN (the bare gauntlet's witch killed the bot from 8 health through one flight; with
    // a sword the fight is better: the live kit's mixed 8 died once running from it through the crowd, ADR 0079)
    if (!out && h < WITCH_FLEE_HEALTH && !this.hasBlade()) {
      const w = this.nearestOfKind(me, FLEE_SCAN, (t) => t === 'witch');
      if (w) out = { why: 'low', threat: w };
    }
    // (Track M4, `shooterHome`: not from an archer with a line on the bot: it shoots at home too. Not for a witch: she walks
    // after a bot that runs, and guard at home kills her, Track M2)
    if (out && this.atFleeDest(me) && dist(entityFeet(out.threat), me) > 6 && !(this.rules.shooterHome && this.shootersWithin(me, FLEE_SCAN, false) > 0)) out = undefined;
    // Track M3: with the elytra flee able and no blade, an archer or a witch with a line on the bot is fled from the air
    // below FLY_SHOOTER_HEALTH: a fist does not reach them, a run in the open stays in their range, and the takeoff takes
    // up to a second, which at fleeHealth is one arrow too late with two of them shooting (also at home: they shoot there too)
    if (!out && h < FLY_SHOOTER_HEALTH && !this.hasBlade() && this.settings.get('fleeFly') && this.fleeFlight?.ready() === true && this.shootersWithin(me, FLEE_SCAN) >= 1) {
      const n = this.nearestOfKind(me, FLEE_SCAN, (t) => DUEL_ARCHERS.has(t) || t === 'witch');
      if (n) out = { why: 'low', threat: n };
    }
    // Track M1 round 2: no blade and an archer or a witch with a line on the bot: the dodge (also at home: they shoot there too)
    if (!out) {
      const s = this.dodgeShooters(me);
      if (s.length) {
        const n = this.nearestOfKind(me, DODGE_RANGE, (t) => DUEL_ARCHERS.has(t) || t === 'witch');
        if (n) out = { why: 'low', threat: n };
      }
    }
    return out;
  }

  /**
   * One melee mob alone and the health for 3 more of its hits (the last hit taken, else 3; within the
   * last minute): fight it instead of running. A zombie chases as fast as the bot runs (measured: a
   * 60 s flight over 260 blocks with a zombie on its heels the whole way), so running from one only
   * trades hits for distance; running is for crowds, archers at low health, creepers.
   */
  canDuel(me: Vec3): boolean {
    if (!this.guardOn) return false; // nobody fights it
    if (this.archerDuelTarget(me)) return true; // Track M4: at home the archer is closed in on whatever the health
    const now = performance.now();
    let lost = 0;
    for (const h of this.recentHits) if (now - h.at < 6000) lost += h.damage;
    let n = 0;
    let ranged = false;
    let archers = 0;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || dist(entityFeet(e), me) > FLEE_SCAN) continue;
      n++;
      const t = bareType(e.type);
      if (DUEL_ARCHERS.has(t)) archers++;
      else if (FLEE_RANGED.has(t) || t === 'creeper') ranged = true;
      if ((this.ignore.get(e.runtimeId) ?? 0) > now) return false; // guard will not pick it
    }
    // Track M1 round 2: a lone archer is closed in on only with a blade (a fist needs about 20 hits; bare, every such duel
    // in the gauntlet died: the dodge or the flight instead)
    const archer = archers > 0 && archers === n && this.hasBlade();
    if (archers > 0 && !archer) ranged = true;
    if (ranged || n === 0 || n > (archer ? DUEL_ARCHERS_MAX : 1)) return false;
    // losing: 4 or more health in the last 6 s (the fight is not going our way, or not happening). Track M1: archers
    // alone (up to two) are closed in on to 8 in 6 s (an arrow is 3 to 5; running in the open keeps the bot in their
    // range: the bare gauntlet's lone skeleton killed the bot through two flights, ADR 0079)
    if (lost >= (archer ? DUEL_ARCHER_LOST : 4)) return false;
    const hit = this.lastHit && performance.now() - this.lastHit.at < 60_000 ? this.lastHit.damage : 3;
    return this.healthAfterPoison() > (archer ? 2 : 3) * Math.max(hit, 1); // Track M4: what the poison will leave
  }

  nearestOfType(type: string): EntityInfo | undefined {
    const me = this.d.loop.state.pos;
    let best: EntityInfo | undefined;
    let bd = Infinity;
    const now = performance.now();
    for (const e of this.d.world.entities.values()) {
      if (isPlayerEntity(e) || classify(e.type) === 'item' || !typeMatches(e.type, type)) continue;
      if ((this.ignore.get(e.runtimeId) ?? 0) > now || this.mobs.get(e.runtimeId)?.dead) continue;
      const d = dist(entityFeet(e), me);
      if (d <= KILL_SEARCH && d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  /** Track M1: count a floor taken (metrics `pve.floor.<name>`). */
  floorUsed(f: Floor): void {
    this.floors[f] = (this.floors[f] ?? 0) + 1;
    this.d.metrics?.inc(`pve.floor.${f}`);
  }

  /** Track M1: a melee threat within `r` (feet, 3D). */
  /**
   * Track M1: the health at most FLOOR_CRITICAL with a melee mob within FLOOR_CRITICAL_RANGE, or at most FLOOR_CRITICAL_HIT
   * with a hit taken in the last 3 s (an archer that keeps hitting a body that runs in the open): running is not working.
   */
  critical(me: Vec3): boolean {
    const h = this.health();
    const now = performance.now();
    const hit = this.recentHits.some((x) => now - x.at < 3000);
    // Track M1 round 2: under SEAL_CROWD shooters or more the shell has to go up while there is health to build it (9
    // blocks take about 2 s; round 2's seal-5 cell sealed at 7, 3 and 2 health and two of them died building it). Only
    // where the shell can go up (sealIn on), so the defaults (run) do not change.
    if (h <= FLOOR_CRITICAL_CROWD && hit && this.shootersWithin(me, 16) >= SEAL_CROWD && this.canSeal()) return true;
    if (h > FLOOR_CRITICAL_HIT) return false;
    if (hit) return true; // still being hit at 8: two arrows from death, a dig-in takes about 3 s
    return h <= FLOOR_CRITICAL && this.meleeWithin(me, FLOOR_CRITICAL_RANGE);
  }

  /**
   * Track M4 (`shooterHome`): a live archer or witch within r of `p` (level), seen or not. In 17 of 26 deaths of the stone
   * kit's `seal-5` the flight on foot had a leg home in its last 10 s, at 1 to 6 health: home was "clear" by the angle rule
   * (no threat nearer than home in its direction) while the skeletons stood 12 to 15 from it, beside it or beyond it.
   */
  shooterNear(p: Vec3, r: number): boolean {
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const t = bareType(e.type);
      if (!DUEL_ARCHERS.has(t) && t !== 'witch') continue;
      const f = entityFeet(e);
      if (Math.hypot(f.x - (p.x + 0.5), f.z - (p.z + 0.5)) <= r) return true;
    }
    return false;
  }

  /**
   * Track M5 (`shooterWay`): a live archer or witch within r (level) of the way from `me` to the block `to`, seen or not.
   * In the stone kit's night `mixed-8` and `seal-5` deaths the bot stood at 1 to 2 health 30 to 50 blocks out, poisoned,
   * with nothing within 16; the danger was over, so home counted as clear, and each leg home walked back into the
   * skeleton that had followed it out (seen again at 11 to 15, the next arrow the last).
   */
  shooterOnWay(me: Vec3, to: Vec3, r: number): boolean {
    const b = { x: to.x + 0.5, z: to.z + 0.5 };
    // behind the bot (away from home): the way home runs from it, not past it
    const onWay = (f: Vec3): boolean => (f.x - me.x) * (b.x - me.x) + (f.z - me.z) * (b.z - me.z) >= 0 && segmentDistance(f, me, b) <= r;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const t = bareType(e.type);
      if (!DUEL_ARCHERS.has(t) && t !== 'witch') continue;
      if (onWay(entityFeet(e))) return true;
    }
    return this.rememberedShooters().some(onWay); // and the ones out of the server's range
  }

  /**
   * Track M5 (`poisonBite`): the flight on foot holds its bites. On the gauntlet a bot with no blade fled a witch at 1 to 2
   * health, poisoned, with her walking after it at 13 to 16; each bite slowed the body (an item in use) and she came to 10 to
   * 12 and threw (both witch deaths of `none` witch-2, 2026-11-16: `eating` in the last 3 s before the harming).
   */
  biteHeld(me: Vec3): boolean {
    if (!this.rules.poisonBite || this.food() <= FOOD_SPRINT_EAT) return false;
    const p = this.mobs.selfPoison;
    if (!p || performance.now() >= p.until) return false;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const t = bareType(e.type);
      if (!DUEL_ARCHERS.has(t) && t !== 'witch') continue;
      if (dist(entityFeet(e), me) <= FLEE_SCAN + 8) return true;
    }
    return false;
  }

  /**
   * Track M10 (`followHome`): home lies ahead of the bot: at least one archer or witch known (seen or not, the remembered
   * ones too), every one of them FOLLOW_HOME_LEAD farther from home than the bot, and none within SHOOTER_WAY of the way.
   */
  homeAhead(me: Vec3, home: Vec3): boolean {
    const hc = { x: home.x + 0.5, z: home.z + 0.5 };
    const mine = Math.hypot(me.x - hc.x, me.z - hc.z);
    const all: Vec3[] = [...this.rememberedShooters()];
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const t = bareType(e.type);
      if (DUEL_ARCHERS.has(t) || t === 'witch') all.push(entityFeet(e));
    }
    if (all.length === 0) return false;
    if (all.some((f) => Math.hypot(f.x - hc.x, f.z - hc.z) < mine + FOLLOW_HOME_LEAD)) return false;
    return !this.shooterOnWay(me, home, SHOOTER_WAY);
  }

  /** Track M1 round 2: archers and witches within r (feet) with a line on the bot (Track M4: `witches` false, archers only). */
  shootersWithin(me: Vec3, r: number, witches = true): number {
    const grid = targeting.gridOf(this.mover);
    const eye = { x: me.x, y: me.y + 1.62, z: me.z };
    let n = 0;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const t = bareType(e.type);
      if (!DUEL_ARCHERS.has(t) && !(witches && t === 'witch')) continue;
      if (dist(entityFeet(e), me) > r || (grid && !targeting.lineOfSight(grid, eye, e))) continue;
      n++;
    }
    return n;
  }

  /**
   * Track M6 (`volley`): the shooters in sight and one round of their damage: archers within FLEE_SCAN and witches within
   * VOLLEY_WITCH_RANGE with a line on the bot, each at its own last hit on the bot (else the last hit of its type, else
   * VOLLEY_ARROW or VOLLEY_HARMING).
   */
  volleyNow(me: Vec3): { shooters: number; damage: number } {
    const grid = targeting.gridOf(this.mover);
    const eye = { x: me.x, y: me.y + 1.62, z: me.z };
    const shots: { kind: 'archer' | 'witch'; last?: number }[] = [];
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const t = bareType(e.type);
      const kind = DUEL_ARCHERS.has(t) ? 'archer' : t === 'witch' ? 'witch' : undefined;
      if (!kind) continue;
      if (dist(entityFeet(e), me) > (kind === 'witch' ? VOLLEY_WITCH_RANGE : FLEE_SCAN) || (grid && !targeting.lineOfSight(grid, eye, e))) continue;
      // a drop is blamed on a guess (the hit guess): a creeper's blast or two hits in one health packet beside a skeleton
      // would make one shot of 9 or 20 (a health set by command did, in pve-m6), so a last hit counts at most VOLLEY_SHOT_MAX
      const seen = this.lastDamageBy.get(e.runtimeId) ?? this.lastDamageByType.get(t);
      const last = seen === undefined ? undefined : Math.min(seen, VOLLEY_SHOT_MAX);
      shots.push(last !== undefined ? { kind, last } : { kind });
    }
    return { shooters: shots.length, damage: volleyRound(shots, this.armourPoints()) };
  }

  /** Track M6: the armour points the bot wears (0 to 20; the armour window, skills/survival/armour.ts armourScore). */
  armourPoints(): number {
    const worn = this.d.world.inventory.window(WINDOW_ARMOR)?.slots ?? [];
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const s = worn[i];
      if (s && s.count > 0) n += Math.floor(armourScore(s.name) / 10);
    }
    return n;
  }

  /**
   * Track M6 (`volley`): at fleeHealth or over, the health is at most one round of the shooters in sight (VOLLEY_MIN_SHOOTERS
   * or more). The case: the stone kit's night `seal-5` fought at home at 8 to 13 health with three skeletons and a witch in
   * sight; one throw (6) and one arrow (4) are more than the margin over fleeHealth 8, and the flight on foot started after
   * the round that killed (Track M5's traces).
   */
  volleyLow(me: Vec3): boolean {
    if (!this.rules.volley) return false;
    const h = this.health();
    if (h <= 0 || h < this.fleeHealth) return false; // already low: the ordinary rule
    const v = this.volleyNow(me);
    return v.shooters >= VOLLEY_MIN_SHOOTERS && h <= v.damage;
  }

  /**
   * Track M6 (`bareArcher`): with no blade carried (carriesBlade: the hotbar or the main slots), the nearest archer (skeleton, stray, bogged, pillager) within
   * FLEE_SCAN with a line on the bot, to run from at any health. The case: the no-kit `pillager-1` cell (6 runs, whole-run
   * traces, 2026-11-16): guard chased the pillager with a fist from 20 health, and it hit every 47 ticks from 2 to 5 blocks
   * (17 hits in 1 245 ticks of the fight: 20 to 9 in 7 s); the flight on foot started at 5 to 7 with the fourth bolt, and
   * from then on one bolt about every 26 s (8.3 to 9.6 blocks: its reach ends there) was what killed at 1 to 6 health.
   */
  bareArcher(me: Vec3): EntityInfo | undefined {
    if (!this.rules.bareArcher || this.carriesBlade()) return undefined;
    const grid = targeting.gridOf(this.mover);
    const eye = { x: me.x, y: me.y + 1.62, z: me.z };
    let best: EntityInfo | undefined;
    let bd = Infinity;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead || !DUEL_ARCHERS.has(bareType(e.type))) continue;
      const d = dist(entityFeet(e), me);
      if (d > FLEE_SCAN || d >= bd || (grid && !targeting.lineOfSight(grid, eye, e))) continue;
      bd = d;
      best = e;
    }
    return best;
  }

  /**
   * Track M9: the nearest live archer (skeleton, stray, bogged, pillager) within FLEE_SCAN + 8 of the bot, seen or not: the
   * one a flight on foot has following it (`followRun`, `sprintJump`).
   */
  followingArcher(me: Vec3): EntityInfo | undefined {
    let best: EntityInfo | undefined;
    let bd = Infinity;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead || !DUEL_ARCHERS.has(bareType(e.type))) continue;
      const d = dist(entityFeet(e), me);
      if (d > FLEE_SCAN + 8 || d >= bd) continue;
      bd = d;
      best = e;
    }
    return best;
  }

  /**
   * Track M10: the archer `followRun` keeps the home leg shut for: the one following (followingArcher), else the nearest live
   * archer within FLEE_SCAN + 8 (level) of the way from `me` to the block `to`. Track M9 looked at the bot alone, so an archer
   * 24 to 26 off that stood towards home let the leg go home, and the first blocks of it walked back within 24 (pve-m9's
   * `home-leg samples with the pillager within 24`); in the long case 117 of 120 `home -> far` flips came that way.
   */
  archerNearWay(me: Vec3, to: Vec3): EntityInfo | undefined {
    const near = this.followingArcher(me);
    if (near) return near;
    const b = { x: to.x + 0.5, z: to.z + 0.5 };
    let best: EntityInfo | undefined;
    let bd = Infinity;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead || !DUEL_ARCHERS.has(bareType(e.type))) continue;
      const d = segmentDistance(entityFeet(e), me, b);
      if (d > FLEE_SCAN + 8 || d >= bd) continue;
      bd = d;
      best = e;
    }
    return best;
  }

  meleeWithin(me: Vec3, r: number): boolean {
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || !targeting.isMelee(e, this.mobs)) continue;
      if (dist(entityFeet(e), me) <= r) return true;
    }
    return false;
  }

  /** Track M1: something the eat skill would eat now (skills/survival/eat.ts chooseFood). */
  hasFood(): boolean {
    return chooseFood(this.d.world.inventory.slots.slice(0, 36), { food: Math.min(this.food(), 19), health: this.health() }) !== undefined;
  }

  /** Track M1: the seal-in's ports (undefined without a placer). */
  sealDeps(): SealDeps | undefined {
    const m = this.mover;
    if (!m.place || !m.dig) return undefined;
    const grid = targeting.gridOf(m);
    return {
      place: (p, o) => m.place!(p, o),
      dig: (p) => m.dig!(p),
      solid: (x, y, z) => {
        const c = grid?.cls(x, y, z);
        return c === undefined ? undefined : c.boxes.length > 0 && c.top >= 1;
      },
      // Track E10: what a click places against (a crafting table or a furnace opens instead)
      face: (x, y, z) => {
        const c = grid?.cls(x, y, z);
        const n = this.d.world.blockAt?.({ x, y, z })?.name;
        return c === undefined || n === undefined ? undefined : clickableName(n.replace(/^minecraft:/, ''), c.boxes.length > 0);
      },
      position: () => this.position(),
      threats: () => this.threatsNear(this.position(), 16),
      slots: () => this.d.world.inventory.slots,
      block: (x, y, z) => this.d.world.blockAt?.({ x, y, z })?.name,
      settle: (n) => {
        const loop = this.d.loop;
        return loop.waitTicks ? loop.waitTicks(n) : new Promise((res) => setTimeout(res, n * 50));
      },
      centre: async (cell, o) => {
        // onto the cell's centre (a body on the cell's edge stands on its neighbour too and never falls in): walking while
        // farther than 0.5, sneaking the rest (no overshoot); into a dug hole (fall) never sneaking (a sneaking body stops at
        // the edge). 30 ticks at most (sneaking covers about 0.04 a tick).
        const loop = this.d.loop;
        for (let i = 0; i < 30; i++) {
          const p = this.position();
          const ax = cell.x + 0.5 - p.x;
          const az = cell.z + 0.5 - p.z;
          const d = Math.hypot(ax, az);
          if (d < 0.15 || (o?.fall && p.y < cell.y + 0.5)) break;
          loop.setCommand({ yaw: (Math.atan2(-ax, az) * 180) / Math.PI, pitch: 0, forward: 1, strafe: 0, sprint: false, jump: false, sneak: !o?.fall && d < 0.5 });
          await (loop.waitTicks ? loop.waitTicks(1) : new Promise((res) => setTimeout(res, 50)));
        }
        loop.setCommand({ forward: 0, strafe: 0, sprint: false, jump: false, sneak: false });
        const p = this.position();
        return Math.hypot(cell.x + 0.5 - p.x, cell.z + 0.5 - p.z) < 0.25;
      },
      log: this.log,
    };
  }

  /** Track M1: blocks enough for the shell where the bot stands, or ground to dig in (skills/survival/seal.ts). */
  canSeal(): boolean {
    if (!this.settings.get('sealIn')) return false;
    const d = this.sealDeps();
    return d !== undefined && canSealHere(d);
  }

  countFight(r: FightResult): void {
    this.stats.fights++;
    this.d.metrics?.inc('pve.fights');
    this.d.metrics?.inc(`pve.fight.${r.reason}`);
    if (r.ok) {
      this.stats.kills++;
      this.d.metrics?.inc('pve.kills');
    }
  }
}

// ---- processes ------------------------------------------------------------------------------------

/**
 * Flee v2 (priority 100; wave 7 Track W, docs/pve.md "Flee"). Every 5 ticks while active:
 *   away  runAway to FLEE_AWAY (12) from every threat within 24
 *   home  the shelter (else home) once 12 clear and no threat is between (bearing > 60 degrees off the
 *         home bearing, or farther than home)
 *   far   home blocked or none: runAway on to FLEE_FAR (40), re-planned every 2 s
 * Ends: arrived at the shelter / home; 2 s out of danger (no threat within 16, or health back to
 * fleeHealth + 6 and no creeper rule) when there is no home to go to or a command waits; cornered (no
 * way away with a threat within 4: guard defends in place); or 60 s. After a flight the bot keeps
 * recovering for up to 2 min: a hostile within 16 starts a flight again until the health is back to
 * fleeHealth + 6 (no yo-yo between fleeing at 7.9 and fighting again at 8.1). While fleeing and 8
 * clear of every hostile it eats below health 10 (the kit's own automatic eating is held during the
 * flight so it never starts a bite next to a mob).
 */
class FleeProcess extends BaseProcess {
  readonly name = 'flee';
  readonly kind = 'auto' as const;
  protected override persistent = true;
  private ep: { why: 'low' | 'creeper'; from: string; start: Vec3; startAt: number; phase: 'away' | 'home' | 'far' | 'seal' | 'sealed' | 'dodge'; dest: { to: Vec3; kind: string } | undefined; safeSince: number | undefined; planAt: number; goalKey: string; bites: number; stallUntil: number; cornered: boolean; planNearest: number; panics: number; caughtSince: number | undefined; legAt?: number; homeOkAt?: number; homeShotSaid?: boolean; wayShotSaid?: boolean; biteHeldSaid?: boolean; runShort?: boolean; longSaid?: boolean; followSaid?: boolean; aheadSaid?: boolean; sealedAt?: number; dugIn?: boolean; seal?: { placed: number; open: number; reason?: string; tries: number; openCells?: Vec3[] }; dodge?: { dir: 1 | -1; sinceFlip: number; seen: Set<bigint>; lastShot: number; t: number; clearSince: number | undefined } } | undefined;
  private plan: { why: 'low' | 'creeper'; threat: EntityInfo; foot?: true } | undefined;
  private cooldownUntil = 0;
  /** The last flight ended cornered (no way away): the cooldown then holds even for a hard trigger. */
  private cornered = false;
  private n = 0;
  private gotoId = 0;
  private walking = false;
  private heldAutoEat: { had: boolean; value: boolean | undefined } | undefined;
  /** After a flight: health to get back to before fighting again, and until when that holds. */
  private recoverTo = 0;
  /** Ticks left of a hand-steered run (the planner could not start). */
  private panic = 0;
  private recoverUntil = 0;
  /** Track M1: the floors: when a flight last ended caught / cornered, the last elytra flee and seal-in, the floor asked for. */
  private failedAt = -Infinity;
  private flyAt = -Infinity;
  private sealAt = -Infinity;
  private mode: 'fly' | 'seal' | undefined;
  private sealing: Promise<void> | undefined;
  private readonly c: PveController;

  constructor(c: PveController) {
    super();
    this.c = c;
  }

  get priority(): number {
    return PRIORITY.flee;
  }

  /** Track M1: the floor now (pveFloor with what the controller knows). */
  floorFor(me: Vec3, danger: boolean): Floor {
    const c = this.c;
    const now = performance.now();
    const threats = c.threatsNear(me, FLEE_SCAN + 8);
    const nearest = threats.reduce((m, f) => Math.min(m, Math.hypot(f.x - me.x, f.z - me.z)), Infinity);
    const failed = now - this.failedAt < FLOOR_FAILED_MS;
    const critical = c.critical(me);
    const late = failed || critical; // the seal-in is looked at only then (an inventory scan)
    const clear = c.eatClearance(me, nearest);
    // Track M3: the elytra flee, asked whenever there is danger (the kit and the sky over the body: a hotbar scan and a column)
    const fly = danger && c.settings.get('fleeFly') && now - this.flyAt > FLOOR_RETRY_MS && (c.fleeFlight?.ready() ?? false);
    return pveFloor({
      danger,
      canDuel: c.canDuel(me),
      nearest: clear,
      health: c.health(),
      food: c.food(),
      hasFood: clear >= FLEE_EAT_CLEAR ? c.hasFood() : false,
      failed,
      critical,
      fly,
      flyFirst: fly && (!c.hasBlade() || c.health() <= FLY_FIRST_HEALTH),
      seal: late && now - this.sealAt > FLOOR_RETRY_MS && c.canSeal(),
    });
  }

  /**
   * Track M3: the elytra flee, through the flight's own entry point (chat/commands-fly.ts `flee`). Its trip holds the body
   * from here until the flight has ended (flyHandover); a flee that made no takeoff answers at once and the other floors
   * go on (it is not asked again for FLOOR_RETRY_MS).
   */
  private flyNow(why: string): void {
    const c = this.c;
    this.flyAt = performance.now();
    c.floorUsed('fly');
    c.log.warn(`floor: elytra flee (${why}, health ${c.health().toFixed(1)})`);
    for (const k of c.processes.find('kill')) c.processes.stop(k, 'stopped');
    // a walk home that waits its turn is dropped: it would take the body straight back to what it flies from (on bds-pve a
    // flee that landed 96 blocks off at 7 health was walked home by it within 13 s, to the witch, and died there)
    for (const h of c.processes.find('home')) c.processes.stop(h, 'dropped');
    c.guardProcess.cancelEpisode();
    const flight = c.fleeFlight;
    if (!flight) return;
    c.flyAsked = true;
    void flight
      .go(why)
      .catch((e: unknown): FleeFlightResult => ({ ok: false, flew: false, reason: e instanceof Error ? e.message : String(e), line: `no elytra flee: ${e instanceof Error ? e.message : String(e)}` }))
      .then((r) => {
        c.flyAsked = false;
        c.lastFleeFlight = r;
        c.d.metrics?.inc(r.flew ? (r.ok ? 'pve.fleefly.landed' : 'pve.fleefly.ended') : 'pve.fleefly.refused');
        c.log.warn(`floor: ${r.line}`);
        if (r.flew) {
          // down somewhere else: the flight on foot's recovery rule holds from here (no fight below fleeHealth + 6)
          this.recoverTo = Math.min(20, c.fleeHealth + FLEE_RECOVER);
          this.recoverUntil = performance.now() + FLEE_RECOVER_MS;
        }
      });
  }

  override wants(): boolean {
    if (this.ep) return true;
    this.plan = undefined;
    const c = this.c;
    if (c.d.night?.state === 'going') return false;
    if (c.flyHandover()) return false; // Track M2: the elytra flee's takeoff has the body
    const me = c.position();
    // A hard trigger (health below fleeHealth, a creeper near at low health) with the threat within 6 blocks,
    // away from home / the shelter, ignores the cooldown after a flight: a zombie that catches up with the bot
    // at 7 health must not get 10 s of "defending in place" in the open (gaunt-flee ring 2). At the destination,
    // with the threat farther off, and after a cornered end, the cooldown holds and guard defends in place;
    // recovery flights always wait it out.
    let r = c.fleeReason(me);
    // Track M1: running has failed (caught, cornered) or the health is critical next to a melee mob: the elytra flee or the
    // seal-in when they can go (whatever the cooldown says), else guard defends in place as before
    // (Track M3: with `fleeFly` on the floor is asked at every flee trigger: the elytra flee may come before the run)
    if (r && !r.foot && (performance.now() - this.failedAt < FLOOR_FAILED_MS || c.critical(me) || c.settings.get('fleeFly'))) {
      const f = this.floorFor(me, true);
      if (f === 'fly' || f === 'seal') {
        this.plan = r;
        this.mode = f;
        return true;
      }
    }
    const urgent = r !== undefined && !this.cornered && !c.atFleeDest(me) && dist(entityFeet(r.threat), me) <= FLEE_URGENT;
    if (performance.now() < this.cooldownUntil && !urgent) return false;
    if (!r && this.recovering()) {
      // recovering: run from what chases (melee mobs within 12); archers are better closed in on
      const t = c.nearestHostile(me, FLEE_RECOVER_SCAN);
      if (t && !FLEE_RANGED.has(bareType(t.type)) && !c.canDuel(me) && !c.holds(me) && !(c.atFleeDest(me) && dist(entityFeet(t), me) > 6)) r = { why: 'low', threat: t };
    }
    if (!r) return false;
    this.plan = r;
    return true;
  }

  /** A melee hostile within FLEE_SCAN (recovery flights do not run from archers). */
  private meleeNear(me: Vec3): boolean {
    const c = this.c;
    for (const e of c.d.world.entities.values()) {
      if (!c.isThreat(e) || FLEE_RANGED.has(bareType(e.type))) continue;
      if (dist(entityFeet(e), me) <= FLEE_SCAN) return true;
    }
    return false;
  }

  /** Still recovering from a flight: health below fleeHealth + 6, within 1 min of it. */
  recovering(): boolean {
    const h = this.c.health();
    return h > 0 && h < this.recoverTo && performance.now() < this.recoverUntil;
  }

  protected run(t: number, resumed: boolean): void {
    const c = this.c;
    if (!this.ep) {
      const plan = this.plan;
      if (!plan) return;
      const me = c.position();
      const mode = this.mode;
      this.mode = undefined;
      if (mode === 'fly') {
        this.flyNow(`${performance.now() - this.failedAt < FLOOR_FAILED_MS ? 'running failed' : c.critical(me) ? 'health critical' : !c.hasBlade() ? 'no blade' : 'health low'} with ${bareType(plan.threat.type)} at ${dist(entityFeet(plan.threat), me).toFixed(1)}`);
        this.yieldControl();
        return;
      }
      this.ep = { why: plan.why, from: plan.threat.type, start: { ...me }, startAt: performance.now(), phase: mode === 'seal' ? 'seal' : 'away', dest: c.fleeTarget(me), safeSince: undefined, planAt: 0, goalKey: '', bites: 0, stallUntil: 0, cornered: false, planNearest: Infinity, panics: 0, caughtSince: undefined };
      c.stats.flees++;
      c.d.metrics?.inc('pve.flees');
      c.noteFlightStart(me); // Track M10 (`backHome`)
      c.floorUsed(mode === 'seal' ? 'seal' : 'backoff'); // Track M1
      events.emit('combat.flee', { why: plan.why, from: bareType(plan.threat.type), health: Math.round(c.health() * 10) / 10 }); // decision 0059
      this.cornered = false;
      this.recoverTo = Math.min(20, c.fleeHealth + FLEE_RECOVER);
      this.recoverUntil = performance.now() + FLEE_RECOVER_MS;
      c.log.warn(
        `flee: ${plan.why === 'creeper' ? (c.health() >= FLEE_CREEPER_HEALTH ? `${c.mobs.ticksLit(plan.threat.runtimeId) >= CREEPER_LIT_BACKOFF ? `a creeper's fuse lit ${Math.round(c.mobs.ticksLit(plan.threat.runtimeId))} ticks` : `creeper within ${CREEPER_BACKOFF_RANGE} and the strike in hand does not keep it off`} (health ${c.health().toFixed(1)}): backing off` : `creeper within ${FLEE_CREEPER_RANGE}`) : c.low() ? `health ${c.health().toFixed(1)} < ${c.fleeHealth}` : c.volleyLow(me) ? ((v) => `health ${c.health().toFixed(1)} at most one round of ${v.shooters} shooters in sight (${v.damage.toFixed(1)})`)(c.volleyNow(me)) : c.bareArcher(me) ? `no blade with an archer in sight (health ${c.health().toFixed(1)})` : `recovering (health ${c.health().toFixed(1)} < ${this.recoverTo})`} with ${bareType(plan.threat.type)} at ${dist(entityFeet(plan.threat), me).toFixed(1)}; running away${this.ep.dest ? `, then to ${this.ep.dest.kind} ${this.ep.dest.to.x} ${this.ep.dest.to.y} ${this.ep.dest.to.z} when clear` : ''}`,
      );
      // a kill job does not survive a flight; a guard fight ends
      for (const k of c.processes.find('kill')) c.processes.stop(k, 'stopped');
      c.guardProcess.cancelEpisode();
      this.holdAutoEat();
      // a threat in reach: sprint away by hand at once (planning takes a moment; a zombie hits every second)
      if (mode !== 'seal' && c.threatsNear(me, 4).length > 0) this.panic = 10;
      if (mode === 'seal') c.log.warn(`floor: seal in (health ${c.health().toFixed(1)}, ${bareType(plan.threat.type)} at ${dist(entityFeet(plan.threat), me).toFixed(1)})`);
    } else if (resumed) {
      c.log.info(`flee: resuming (${this.ep.phase})`);
    }
    this.ep.goalKey = ''; // plan again
    this.n = 0;
    this.step(t);
  }

  tick(): void {
    const dep = this.ep;
    if (dep?.phase === 'dodge' && dep.dodge && this.controlled) {
      this.dodgeTick(dep);
      if (++this.n % 5 === 0) this.step(this.token);
      return;
    }
    if (this.panic > 0) {
      // the planner could not start (knocked into the air, no standable node): run straight away by hand
      const c = this.c;
      const me = c.position();
      const threats = c.threatsNear(me, FLEE_SCAN);
      let ax = 0;
      let az = 0;
      for (const t of threats) {
        const d = Math.max(0.5, Math.hypot(me.x - t.x, me.z - t.z));
        ax += (me.x - t.x) / (d * d);
        az += (me.z - t.z) / (d * d);
      }
      if (c.mover.onScaffold?.()) {
        // decision 0051: on a felling pillar: come down first (sneaking, block by block), no sprint off the top
        c.d.loop.setCommand({ forward: 0, strafe: 0, sprint: false, jump: false, sneak: true });
        void c.mover.descendFirst?.();
      } else if (ax !== 0 || az !== 0) c.d.loop.setCommand({ yaw: (Math.atan2(-ax, az) * 180) / Math.PI, pitch: 0, forward: 1, strafe: 0, sprint: true, jump: false });
      if (--this.panic === 0) {
        c.d.loop.release();
        if (this.ep) this.ep.goalKey = '';
      }
      return;
    }
    if (++this.n % 5 === 0) this.step(this.token);
  }

  /** Track M1 round 2: one tick of the dodge (skills/combat/dodge.ts): steer across the nearest shooter's line; eat between shots. */
  private dodgeTick(ep: NonNullable<FleeProcess['ep']>): void {
    const c = this.c;
    const dz = ep.dodge!;
    dz.t++;
    dz.sinceFlip++;
    const me = c.position();
    const shot = c.shotInFlight(me);
    for (const id of shot.ids) {
      if (!dz.seen.has(id)) {
        dz.seen.add(id);
        dz.lastShot = dz.t;
      }
    }
    if (dz.seen.size > 64) dz.seen = new Set(shot.ids);
    const step = dodgeStep({ me, shooters: c.dodgeShooters(me), dir: dz.dir, inFlight: shot.any, sinceFlip: dz.sinceFlip, grid: targeting.gridOf(c.mover) });
    if (!step) {
      // no safe way across or out (or nobody in sight any more): the ordinary flight plans from here
      c.d.loop.release();
      ep.dodge = undefined;
      ep.phase = 'away';
      ep.goalKey = '';
      return;
    }
    if (step.flipped) dz.sinceFlip = 0;
    dz.dir = step.dir;
    c.d.loop.setCommand({ yaw: step.yaw, pitch: 0, forward: 1, strafe: 0, sprint: true, jump: false, sneak: false });
    // eat right after a shot (the next one is 40 ticks or more away), with no shot in the air, the nearest shooter 8 or more off
    const kit = c.kit?.();
    if (kit && !(kit as { busy?: boolean }).busy && !shot.any && dz.t - dz.lastShot <= 20 && step.d >= 8 && (c.food() < 18 || c.health() < 14) && c.food() < 20 && c.hasFood()) {
      void kit.eat().then((r) => {
        if (r.ok && this.ep === ep) {
          ep.bites++;
          c.floorUsed('eat');
        }
      });
    }
  }

  private end(why: string, cooldownMs: number): void {
    const ep = this.ep;
    if (!ep) return;
    this.c.log.info(`flee: ${why} after ${((performance.now() - ep.startAt) / 1000).toFixed(1)} s (${Math.round(dist(ep.start, this.c.position()))} blocks${ep.bites ? `, ate ${ep.bites}` : ''})`);
    this.token++;
    if (this.walking && this.c.mover.nav.busy) this.c.mover.cancel();
    this.walking = false;
    if (this.panic > 0 || ep.phase === 'dodge') {
      this.panic = 0;
      this.c.d.loop.release();
    }
    this.ep = undefined;
    this.cooldownUntil = performance.now() + cooldownMs;
    this.releaseAutoEat();
    this.yieldControl();
  }

  /** Evaluate the flight (every 5 ticks and at every (re)start). */
  private step(t: number): void {
    const ep = this.ep;
    const c = this.c;
    if (!ep || t !== this.token || !this.controlled) return;
    const now = performance.now();
    const me = c.position();
    if (ep.phase === 'seal' || ep.phase === 'sealed') {
      this.sealStep(ep, t, now, me);
      return;
    }
    // Track M1 round 2: the dodge (no blade, only shooters near): across their line by hand
    const shooters = c.dodgeShooters(me);
    if (ep.phase === 'dodge') {
      if (now - ep.startAt > FLEE_MAX_MS) {
        this.end('gave up (60 s)', 2000);
        return;
      }
      if (shooters.length > 0) {
        if (ep.dodge) ep.dodge.clearSince = undefined;
        return;
      }
      const melee = c.meleeWithin(me, DODGE_MELEE);
      if (ep.dodge && !melee) {
        ep.dodge.clearSince ??= now;
        if (now - ep.dodge.clearSince < FLEE_SAFE_MS) return;
      }
      c.log.info(`flee: dodge over (${melee ? 'a melee mob near' : 'no shooter in sight'})`);
      c.d.loop.release();
      ep.dodge = undefined;
      ep.phase = 'away';
      ep.goalKey = '';
      if (!melee && !c.fleeReason(me)) {
        this.end('out of the line of fire', 2000);
        return;
      }
    } else if (shooters.length > 0 && ep.phase !== 'home') {
      if (this.walking && c.mover.nav.busy) c.mover.cancel();
      this.walking = false;
      this.panic = 0;
      ep.phase = 'dodge';
      ep.dodge = { dir: 1, sinceFlip: 0, seen: new Set(), lastShot: -100, t: 0, clearSince: undefined };
      c.log.warn(`flee: dodge (${shooters.length} shooter(s) in sight, nearest ${Math.min(...shooters.map((s) => dist(s.pos, me))).toFixed(1)}, health ${c.health().toFixed(1)}): across the line of fire`);
      return;
    }
    const threats = c.threatsNear(me, FLEE_SCAN + 8);
    const nearest = threats.reduce((m, f) => Math.min(m, Math.hypot(f.x - me.x, f.z - me.z)), Infinity);
    // Track M1: running is not working (the health critical next to a melee mob): the next floor when it can go
    if (c.critical(me)) {
      const f = this.floorFor(me, true);
      if (f === 'fly') {
        this.end('health critical next to a melee mob: the elytra flee', 0);
        // (Track M3: ending the episode lets the manager ask the floors again at once, and that look asks for the flee
        // itself: on bds-pve every flee from a running episode was asked twice in the same tick, the second answered
        // `a flee is on its way`)
        if (!c.flyHandover()) this.flyNow('health critical while running');
        return;
      }
      if (f === 'seal') {
        c.log.warn(`floor: seal in (health ${c.health().toFixed(1)} while running, a melee mob within ${FLOOR_CRITICAL_RANGE})`);
        c.floorUsed('seal');
        if (this.walking && c.mover.nav.busy) c.mover.cancel();
        this.walking = false;
        this.panic = 0;
        c.d.loop.release();
        ep.phase = 'seal';
        this.sealStep(ep, t, now, me);
        return;
      }
    }
    // still in danger?
    const reason = c.fleeReason(me);
    this.recoverUntil = Math.max(this.recoverUntil, now + 1000); // a flight in progress keeps the recovery open
    const danger = reason !== undefined || (!c.canDuel(me) && !c.holds(me) && ((c.low() && nearest <= FLEE_SCAN) || (this.recovering() && this.meleeNear(me))));
    ep.dest = c.fleeTarget(me) ?? (ep.dest && c.atFleeDest(me) ? undefined : ep.dest);
    const dest = ep.dest;
    // danger over (2 s): end, unless nothing waits and home is still to reach (then go on, around the threat)
    const commanded = c.processes.userProcesses().length > 0;
    if (!danger) {
      ep.safeSince ??= now;
      if (now - ep.safeSince >= FLEE_SAFE_MS && (!dest || commanded)) {
        this.end(c.low() ? 'no threat within 16' : this.recovering() ? 'no threat within 16 (recovering)' : 'out of danger', this.recovering() ? 0 : 2000); // recovering: the next hostile within 16 starts a flight again, not a fight
        return;
      }
    } else {
      ep.safeSince = undefined;
    }
    if (fleeCaught(ep, now, nearest, c.mobs.lastHitBy?.at)) {
      this.cornered = true;
      this.failedAt = now; // Track M1: the next floor
      this.end(`caught (a threat within ${FLEE_CAUGHT_RANGE} hitting us for ${FLEE_CAUGHT_MS / 1000} s): defending`, 3000);
      return;
    }
    if (now - ep.startAt > FLEE_MAX_MS) {
      const follower = c.rules.followRun && !c.carriesBlade() ? c.followingArcher(me) : undefined;
      // Track M9 (`followRun`): with no blade and the archer still following (within FLEE_SCAN + 8, seen or not: at the
      // minute's end it is often just out of sight, 16 to 18 behind) the next flight starts as soon as it is seen again,
      // with no cooldown (the 2 s cooldown was guard's fist chase: a bolt from 2 to 5 blocks each time, the long case's minute two)
      this.end('gave up (60 s)', follower ? 0 : 2000);
      return;
    }
    this.maybeEat(c.eatClearance(me, nearest));
    // choose the leg
    if (!dest && c.atFleeDest(me) && ep.phase === 'home') {
      this.end(`arrived (${nearest === Infinity ? 'no threat near' : `nearest threat ${nearest.toFixed(1)}`})`, 10_000);
      return;
    }
    // home when clear; also when there is no farther place to run to (cornered: the planner's mob
    // avoidance takes the way around), or when the danger is over and nothing else waits
    const safeNow = ep.safeSince !== undefined && now - ep.safeSince >= FLEE_SAFE_MS;
    // the leg (fleeLeg; Track M4: held against flapping)
    const homeOk = dest !== undefined && (homeClear(me, dest.to, threats) || ep.cornered || safeNow);
    if (!homeOk) ep.homeOkAt = undefined;
    else ep.homeOkAt ??= now;
    // Track M5 (`shooterWay`): at low health not home past an archer or a witch, seen or not
    // Track M10 (`backHome`): with no blade carried, at any health (the way home past a skeleton that stands between: in the
    // long case the leg went home whenever it stood just past 24 and back to far as soon as it was 23.8, every 3 s)
    const wayShot = dest !== undefined && ((c.rules.shooterWay && c.low()) || (c.rules.backHome && !c.carriesBlade())) && c.shooterOnWay(me, dest.to, SHOOTER_WAY);
    if (wayShot && !ep.wayShotSaid) {
      ep.wayShotSaid = true; // said once an episode
      c.log.info(`flee: an archer or a witch within ${SHOOTER_WAY} of the way to ${dest.kind}: staying out at health ${c.health().toFixed(1)}`);
    }
    // Track M9 (`followRun`): with no blade, not home while an archer follows within FLEE_SCAN + 8: the way home turns the
    // body back towards it (in the A/B traces 34 `home` legs in 17 runs, the pillager a median 13 behind, each turned back
    // to `far` after about 15 ticks), and home is where it would follow the bot to. Track M10: nor while the way home passes
    // within 24 of one (archerNearWay: one 24 to 26 off towards home let the leg start and walk back within 24 of it)
    const follows = dest !== undefined && c.rules.followRun && !c.carriesBlade() ? c.archerNearWay(me, dest.to) : undefined;
    // Track M10 (`followHome`): with home ahead (every archer behind the bot), the home leg is open, its doors closed behind
    const ahead = dest !== undefined && c.rules.followHome && !c.carriesBlade() && c.homeAhead(me, dest.to);
    if (ahead && !ep.aheadSaid) {
      ep.aheadSaid = true; // said once an episode
      c.log.info(`flee: ${dest.kind} ahead of every archer (health ${c.health().toFixed(1)}): home, closing the doors behind`);
    }
    if (follows && !ep.followSaid) {
      ep.followSaid = true; // said once an episode
      c.log.info(`flee: ${bareType(follows.type)} following at ${dist(entityFeet(follows), me).toFixed(1)}: not to ${dest!.kind} while it is within ${FLEE_SCAN + 8} of the way`);
    }
    const phase = fleeLeg({
      phase: ep.phase,
      dest: dest !== undefined,
      nearest,
      homeOk,
      farEnough: dist(ep.start, me) >= FLEE_FAR, // far enough: home around the threat
      sinceLeg: now - (ep.legAt ?? 0),
      homeOkMs: ep.homeOkAt === undefined ? 0 : now - ep.homeOkAt,
      hold: c.rules.legHold,
      homeShot: !ahead && ((dest !== undefined && c.rules.shooterHome && c.shooterNear(dest.to, SHOOTER_HOME)) || wayShot || follows !== undefined),
    });
    if (phase !== ep.phase) ep.legAt = now;
    if (c.rules.shooterHome && dest && !ep.homeShotSaid && c.shooterNear(dest.to, SHOOTER_HOME)) {
      ep.homeShotSaid = true; // Track M4: said once an episode
      c.log.info(`flee: an archer or a witch within ${SHOOTER_HOME} of ${dest.kind}: not running there while it stays`);
    }
    if (phase !== ep.phase) c.log.info(`flee: ${ep.phase} -> ${phase}${phase === 'home' && dest ? ` (${dest.kind} clear)` : ''}, nearest threat ${nearest === Infinity ? '-' : nearest.toFixed(1)}`);
    ep.phase = phase;
    // (re)plan: a new leg, the last walk ended, or (checked every 2 s while running away) the nearest
    // threat gained on us since the plan. A plan that still works is kept: every new goto stops the body
    // for a moment, and a chasing zombie is almost as fast as a sprinting bot.
    // Track M9: from an archer that follows a bot with no blade, a long far leg (`followRun`), the
    // sprint-jump (a bot with a blade, the live kit among them, flees as before: none of it measured on its rows)
    const archer = phase !== 'home' && (c.rules.followRun || c.rules.sprintJump) && !c.carriesBlade() ? c.followingArcher(me) : undefined;
    const longLeg = phase === 'far' && archer !== undefined && c.rules.followRun && !ep.runShort;
    const key = phase === 'home' && dest ? `home:${dest.to.x},${dest.to.y},${dest.to.z}` : `${phase}${longLeg ? ':long' : ''}`;
    if (key === ep.goalKey && this.walking && (phase === 'home' || now - ep.planAt < FLEE_REPLAN_MS || nearest >= ep.planNearest - 1)) {
      if (phase !== 'home' && now - ep.planAt >= FLEE_REPLAN_MS) {
        ep.planAt = now; // checked: keep the plan, look again in 2 s
        ep.planNearest = Math.min(ep.planNearest, nearest);
      }
      return;
    }
    if (now < ep.stallUntil) return; // the last leg found no way: stand (guard defends in place), plan again shortly
    ep.goalKey = key;
    ep.planAt = now;
    ep.planNearest = nearest;
    const goal: NavGoal =
      phase === 'home' && dest
        ? { type: 'block', p: dest.to }
        : { type: 'runAway', from: () => c.threatsNear(c.position(), FLEE_SCAN + 8), r: longLeg ? followRunRadius(nearest) : fleeRadius(phase === 'far' ? 'far' : 'away', nearest, c.rules.fleeLong) };

    if (longLeg && !ep.longSaid) {
      ep.longSaid = true; // Track M9, said once an episode
      c.log.info(`flee: a long leg from ${bareType(archer.type)} at ${dist(entityFeet(archer), me).toFixed(1)} (to ${followRunRadius(nearest).toFixed(0)} from it)`);
    }
    const jump = phase === 'far' && archer !== undefined && c.rules.sprintJump && c.food() > SPRINT_JUMP_FOOD;
    const legOpts: GotoOptions = { timeoutTicks: 1200, sprint: true, ...(jump ? { sprintJump: true } : {}), ...(phase === 'home' && ahead ? { closeDoors: true } : {}) };
    const id = ++this.gotoId;
    this.walking = true;
    void c.mover.goto(goal as Goal, legOpts).then((r) => {
      if (id !== this.gotoId || t !== this.token) return;
      this.walking = false;
      const e = this.ep;
      if (!e) return;
      if (r.ok) e.panics = 0;
      if (e.phase === 'home' && r.ok) {
        this.end('arrived', 10_000);
        return;
      }
      if (!r.ok && r.reason !== 'interrupted') {
        c.log.info(`flee: ${e.phase} leg ${r.reason}`);
        e.stallUntil = performance.now() + 1000;
        // Track M9: a long leg not found: the usual legs for the rest of the flight

        if (e.phase === 'far' && r.reason === 'unreachable' && longLeg) e.runShort = true;
        else if (e.phase === 'far' && r.reason === 'unreachable') e.cornered = true; // no farther place: home around the threat next
        if (e.phase !== 'home' && c.threatsNear(c.position(), 8).length > 0) {
          if (++e.panics > 3 && c.threatsNear(c.position(), 4).length > 0) {
            this.cornered = true;
            this.failedAt = performance.now(); // Track M1: the next floor
            this.end('cornered (no way away, a threat within 4): defending', 3000);
            return;
          }
          // no plan from here (often: knocked into the air): 15 ticks straight away by hand, then plan again
          e.stallUntil = 0;
          this.panic = 15;
          return;
        }
      }
      e.goalKey = ''; // the next step plans again
    });
  }

  /**
   * Track M1: the seal-in. `seal`: place the shell (skills/survival/seal.ts), standing still; `sealed`: eat to full and
   * wait until the health is back to SEAL_LEAVE_HEALTH (at most 5 min), then open the side away from the mobs and end.
   */
  private sealStep(ep: NonNullable<FleeProcess['ep']>, t: number, now: number, me: Vec3): void {
    const c = this.c;
    if (ep.phase === 'seal') {
      if (this.sealing) return;
      const deps = c.sealDeps();
      if (!deps) {
        this.end('seal: no placer', 3000);
        return;
      }
      this.sealAt = now;
      // stand still where the shell goes: no walk, no fight moving the body (a debug run on bds-gaunt dug the first two
      // cells of a dig-in and was 3 blocks off it for the third: guard's fight was still walking)
      if (c.mover.nav.busy) c.mover.cancel();
      this.walking = false;
      this.panic = 0;
      c.combat.cancel();
      c.d.loop.setCommand({ forward: 0, strafe: 0, sprint: false, jump: false, sneak: false });
      const at = { ...me };
      const off = (): boolean => Math.hypot(c.position().x - at.x, c.position().z - at.z) > 1.5; // knocked off the spot (an arrow moves it about half a block)
      this.sealing = seal(deps, () => t !== this.token || this.ep !== ep || off()).then(
        (r) => {
          this.sealing = undefined;
          if (t !== this.token || this.ep !== ep) return;
          const tries = (ep.seal?.tries ?? 0) + 1;
          ep.seal = { placed: (ep.seal?.placed ?? 0) + r.placed.length, open: r.open, reason: r.reason, tries, openCells: r.openCells };
          // Track M1 round 2: a surface shell left open (the body knocked off its cell, a cell that would not take a block)
          // is built again from where the body is, once; an open shell is no shelter from arrows
          if (!r.ok && !r.dugIn && tries < SEAL_TRIES) {
            c.log.warn(`floor: the shell is open (${r.open} cell(s)${r.reason ? `, ${r.reason}` : ''}), building it again`);
            return;
          }
          ep.phase = 'sealed';
          ep.sealedAt = performance.now();
          ep.dugIn = r.dugIn;
          c.log.warn(`floor: sealed in (${r.placed.length} placed${r.open ? `, ${r.open} cell(s) open` : ''}${r.reason ? `, ${r.reason}` : ''}), health ${c.health().toFixed(1)}`);
        },
        (e: unknown) => {
          this.sealing = undefined;
          c.log.warn(`floor: seal failed: ${e instanceof Error ? e.message : String(e)}`);
          if (this.ep === ep) this.end('seal failed', 3000);
        },
      );
      return;
    }
    // sealed: eat (whatever is near: the shell is between), stay still
    const kit = c.kit?.();
    if (kit && c.food() < 20 && !(kit as { busy?: boolean }).busy) {
      void kit.eat().then((r) => {
        if (r.ok && this.ep === ep) {
          ep.bites++;
          c.floorUsed('eat');
        }
      });
    }
    const at = ep.sealedAt ?? now;
    // Track M1 round 2: out at full health once no mob is within 16 or it is day (the archers burn), else at SEAL_MAX_MS
    const tod = c.timeOfDay();
    const day = tod !== undefined && (tod < 12_500 || tod > 23_500);
    const clear = c.threatsNear(me, 16).length === 0;
    if (now - at < SEAL_MAX_MS && (c.health() < SEAL_LEAVE_HEALTH || !(clear || day))) return;
    if (this.sealing) return;
    // a dug-in shell opens through its roof (the cell over the head); the walk out is the next goto's
    const side = ep.dugIn ? [{ x: Math.floor(me.x), y: Math.floor(me.y + 1e-3) + 2, z: Math.floor(me.z) }] : openSide(me, c.threatsNear(me, 16));
    const deps = c.sealDeps();
    c.log.info(`floor: opening the shell (health ${c.health().toFixed(1)}, after ${((now - at) / 1000).toFixed(0)} s)`);
    this.sealing = (async () => {
      for (const p of side) {
        if (deps?.solid(p.x, p.y, p.z) === true) await deps.dig(p).catch(() => undefined);
      }
    })().finally(() => {
      this.sealing = undefined;
      if (this.ep === ep) this.end('unsealed', 2000);
    });
  }

  /** Eat below health 10 when every hostile is at least 8 blocks away (the kit's eat; one at a time). */
  private maybeEat(nearest: number): void {
    const c = this.c;
    const kit = c.kit?.();
    const ep = this.ep;
    // below 10; or while recovering with food under 18 (no natural regeneration without it: the bot stayed at 12 health for minutes)
    const hungry = c.health() < FLEE_EAT_BELOW || (this.recovering() && c.food() < 18) || c.food() <= FOOD_SPRINT_EAT; // Track M2: before the food stops the sprint
    if (!kit || !ep || !hungry || nearest < FLEE_EAT_CLEAR || c.food() >= 20) return;
    if ((kit as { busy?: boolean }).busy) return;
    if (c.biteHeld(c.position())) {
      // Track M5 (`poisonBite`), said once an episode
      if (!ep.biteHeldSaid) c.log.info(`flee: no bite while poisoned with an archer or a witch within ${FLEE_SCAN + 8} (health ${c.health().toFixed(1)}, food ${c.food()})`);
      ep.biteHeldSaid = true;
      return;
    }
    void kit.eat().then((r) => {
      if (r.ok && this.ep === ep) {
        ep.bites++;
        c.floorUsed('eat'); // Track M1
      }
    });
  }

  private holdAutoEat(): void {
    const kit = this.c.kit?.();
    if (!kit || this.heldAutoEat) return;
    this.heldAutoEat = { had: 'autoEat' in kit.overrides, value: kit.overrides.autoEat };
    kit.overrides.autoEat = false;
  }

  private releaseAutoEat(): void {
    const kit = this.c.kit?.();
    const h = this.heldAutoEat;
    this.heldAutoEat = undefined;
    if (!kit || !h) return;
    if (h.had) kit.overrides.autoEat = h.value;
    else delete kit.overrides.autoEat;
  }

  protected halt(): void {
    this.gotoId++;
    this.walking = false;
    if (this.panic > 0 || this.ep?.phase === 'dodge') {
      this.panic = 0;
      this.c.d.loop.release();
    }
    if (this.ep?.phase === 'dodge') {
      this.ep.dodge = undefined;
      this.ep.phase = 'away'; // a resume plans again (the dodge comes back in the next step when it still holds)
    }
    if (this.c.mover.nav.busy) this.c.mover.cancel();
  }

  cancelEpisode(): void {
    if (!this.ep) return;
    this.token++;
    if (this.controlled && this.c.mover.nav.busy) this.c.mover.cancel();
    this.walking = false;
    this.ep = undefined;
    this.releaseAutoEat();
    this.yieldControl();
  }

  protected override reset(): void {
    this.ep = undefined;
    this.walking = false;
    this.releaseAutoEat();
  }

  behaviour(): string {
    return 'fleeing';
  }

  status(): ProcessStatus {
    const ep = this.ep;
    if (!ep) return { line: 'flee: watching' };
    const left = this.controlled ? navRemaining(this.c.mover.nav, this.c.position()) : undefined;
    if (ep.phase === 'seal' || ep.phase === 'sealed') return { line: ep.phase === 'seal' ? 'sealing in (mobs)' : 'sealed in, eating and waiting' }; // Track M1
    const where = ep.phase === 'home' && ep.dest ? `to ${ep.dest.kind} ${ep.dest.to.x} ${ep.dest.to.y} ${ep.dest.to.z}` : ep.phase === 'far' ? `away (up to ${FLEE_FAR})` : `away (${FLEE_AWAY})`;
    return { line: `fleeing ${where}${left !== undefined && ep.phase === 'home' ? `, ${Math.round(left)} blocks left` : ''}`, etaS: ep.phase === 'home' ? etaFor(left, this.c.mover.nav.lastReport, true) : undefined };
  }
}

/**
 * The caught rule (FLEE_CAUGHT_RANGE / FLEE_CAUGHT_MS): updates `ep.caughtSince` with the nearest threat's
 * distance; true once one has stayed that close for FLEE_CAUGHT_MS and hit the bot within that time.
 */
export function fleeCaught(ep: { caughtSince: number | undefined }, now: number, nearest: number, lastHitAt: number | undefined): boolean {
  if (nearest > FLEE_CAUGHT_RANGE) {
    ep.caughtSince = undefined;
    return false;
  }
  ep.caughtSince ??= now;
  return now - ep.caughtSince >= FLEE_CAUGHT_MS && lastHitAt !== undefined && lastHitAt >= ep.caughtSince;
}

/**
 * Home is clear of the threats: each one's bearing from the bot is more than FLEE_HOME_ANGLE degrees
 * off the bearing to home, or it is farther away than home.
 */
export function homeClear(me: Vec3, home: Vec3, threats: readonly Vec3[]): boolean {
  const hx = home.x + 0.5 - me.x;
  const hz = home.z + 0.5 - me.z;
  const hd = Math.hypot(hx, hz);
  if (hd < 1e-3) return true;
  for (const t of threats) {
    const tx = t.x - me.x;
    const tz = t.z - me.z;
    const td = Math.hypot(tx, tz);
    if (td > hd) continue;
    if (td < 1e-3) return false;
    const cos = (hx * tx + hz * tz) / (hd * td);
    const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (deg <= FLEE_HOME_ANGLE) return false;
  }
  return true;
}

/** Guard fight (60, or 85 when defending in place): fight, pick up the drops, then maybe walk home. */
class GuardProcess extends BaseProcess {
  readonly name = 'guard';
  readonly kind = 'auto' as const;
  protected override persistent = true;
  private ep: { e: EntityInfo; type: string; inPlace: boolean; phase: 'fight' | 'collect' | 'hold'; work?: boolean } | undefined;
  private pick: { e: EntityInfo; inPlace: boolean; work?: boolean; hold?: boolean } | undefined;
  /** Track E12 (`workGuard`): fights started for a job at work with guard off. */
  workFights = 0;
  /** Track M11 (`workGuard`): holds begun (the work stood still for a witch fought and not dead). */
  workHolds = 0;
  /** Track M11: the witch the last hold line was said for (one line a hold, not one a step). */
  private heldSaid: bigint | undefined;
  private readonly c: PveController;

  constructor(c: PveController) {
    super();
    this.c = c;
  }

  get priority(): number {
    return (this.ep?.inPlace ?? this.pick?.inPlace) ? PRIORITY.defend : PRIORITY.guard;
  }

  /** Track M2: the mob type the guard fight went for (no namespace), undefined when not fighting. */
  get fighting(): string | undefined {
    return this.ep?.phase === 'fight' ? bareType(this.ep.type) : undefined;
  }

  override wants(): boolean {
    if (this.ep) return true;
    this.pick = undefined;
    const c = this.c;
    if (!c.guard.on) {
      // Track E12 (`workGuard`): guard off, a job at work: the archer that shoots at it or the witch near it, by this fight
      if (c.flyHandover()) return false;
      const me = c.position();
      const w = c.workThreat(me);
      if (w) this.pick = { e: w, inPlace: false, work: true };
      else {
        // Track M11: a witch fought for the work and not dead: the work stands still while she is held (heldWorkWitch)
        const h = c.heldWorkWitch(me);
        if (h) this.pick = { e: h, inPlace: false, work: true, hold: true };
        else this.heldSaid = undefined;
      }
      return this.pick !== undefined;
    }
    // a kill job fights already (unless !pause holds it)
    if (!c.processes.paused && c.processes.find('kill').length > 0) return false;
    if (c.flyHandover()) return false; // Track M2: the elytra flee's takeoff has the body
    c.pathReach.prune(); // Track AO: drop stale probe verdicts
    this.pick = c.pickThreat(c.position(), c.low());
    // Track M10 (`followHome`): no fist chase of an archer (it backs off and shoots from 2 to 5 blocks); in place it is struck
    if (this.pick && !this.pick.inPlace && c.rules.followHome && !c.carriesBlade() && DUEL_ARCHERS.has(bareType(this.pick.e.type))) this.pick = undefined;
    return this.pick !== undefined;
  }

  protected run(t: number): void {
    const c = this.c;
    const pick = this.pick;
    if (!pick) return;
    const { e, inPlace } = pick;
    const work = pick.work === true;
    if (pick.hold) {
      // Track M11: stand the work still a moment (the reflex still strikes in reach), then ask again: a fight, the hold, or the work
      this.ep = { e, type: e.type, inPlace: false, phase: 'hold', work: true };
      if (c.mover.nav.busy) c.mover.cancel();
      if (this.heldSaid !== e.runtimeId) {
        this.heldSaid = e.runtimeId;
        this.workHolds++;
        c.d.metrics?.inc('pve.workHold');
        c.log.info(`guard: holds the work: witch #${e.runtimeId} ${dist(entityFeet(e), c.position()).toFixed(1)} off was fought and is not dead (workGuard)`);
      }
      setTimeout(() => {
        if (t !== this.token) return;
        this.ep = undefined;
        this.yieldControl();
      }, 250);
      return;
    }
    const ep = { e, type: e.type, inPlace, phase: 'fight' as 'fight' | 'collect' | 'hold', work };
    this.ep = ep;
    c.stats.guardTriggers++;
    c.d.metrics?.inc('pve.guard');
    if (work) {
      this.workFights++;
      c.d.metrics?.inc('pve.workGuard');
    }
    const archerAtHome = c.low() && c.archerDuelTarget(c.position())?.runtimeId === e.runtimeId; // Track M4
    const rush = !inPlace && c.witchRushes(e, c.position()); // Track M7
    if (rush) c.d.metrics?.inc('pve.witchRush');
    const d = dist(entityFeet(e), c.position());
    c.log.info(`guard: ${bareType(e.type)} #${e.runtimeId} ${work ? `${d.toFixed(1)} off ${bareType(e.type) === 'witch' ? 'near the work' : 'shooting at the work'} (workGuard)` : inPlace ? 'within reach (defending in place)' : `within ${c.guardRadius} blocks`}, fighting${archerAtHome ? ` (the archer at home, health ${c.health().toFixed(1)}: not standing in its line)` : ''}${rush ? ' (a rush: before her next throw)' : ''}`);
    const opts: FightOptions = inPlace ? { approach: false, maxRange: 5, outOfRangeTicks: 20, timeoutTicks: 600 } : { maxRange: c.guardRadius + CHASE_EXTRA, ...(rush ? { rush: true } : {}) };
    void c.combat.fight(e.runtimeId, opts).then(async (r) => {
      if (t !== this.token) return;
      c.countFight(r);
      targeting.afterFight(c, e, r); // Track V: 10 s for out_of_range, none for creeper_avoided / interrupted; Track AO: 30 s for unreachable, with the reason
      if (r.reason === 'unreachable') c.pathReach.forget(e.runtimeId); // Track AO: probe it afresh after the ignore
      if (work && bareType(e.type) === 'witch') c.workWitchFought(e, r); // Track M11: not killed: held (the ignore does not apply to her)
      // Track M1 round 2: the drops only with no other hostile within 16 (the collect walk ran 11 s next to a witch at 4.5
      // and a spider at 2 with no fight, a live-kit mixed-8 death with the reflex off)
      if (r.ok && !inPlace && !c.otherThreatWithin(c.position(), 16, e.runtimeId)) {
        ep.phase = 'collect';
        await c.mover.collect(c.collectRadius, 200);
        if (t !== this.token) return;
      }
      this.ep = undefined;
      // back home when nothing else is queued (and no night shelter wanted); another threat goes first (60 > 20). Track
      // E12: not after a fight for a job at work (the job goes on from where the fight ended)
      if (!inPlace && !work && !c.d.night?.wantsShelter()) {
        const home = c.d.home();
        const me = c.position();
        // only a fight in the home area walks back (an idle bot far away now guards itself: it is not sent 1400 blocks home)
        const hd = home ? dist(me, { x: home.x + 0.5, y: home.y, z: home.z + 0.5 }) : 0;
        if (home && hd > 1.5 && hd <= c.guardRadius + CHASE_EXTRA) void c.returnHome('guard', { timeoutTicks: 2400, ifIdle: true });
      }
    });
  }

  protected halt(): void {
    const c = this.c;
    if (c.combat.busy) c.combat.cancel();
    if (c.mover.nav.busy) c.mover.cancel();
    this.ep = undefined;
  }

  /** Track E12 (`workGuard`): a fight for the work on an archer ends when a second archer comes within range. */
  tick(): void {
    const ep = this.ep;
    if (!ep?.work || ep.phase !== 'fight' || !DUEL_ARCHERS.has(bareType(ep.type))) return;
    const n = this.c.workArchers(this.c.position());
    if (n <= WORK_ARCHERS_MAX) return;
    this.c.log.info(`guard: ${n} archers within ${WORK_ARCHER_RANGE}: the fight for the work on ${bareType(ep.type)} #${ep.e.runtimeId} ends (workGuard)`);
    this.cancelEpisode();
  }

  /** Drop the current fight (stop, guard off, an explicit kill, a flight, a death). */
  cancelEpisode(): void {
    if (!this.ep) return;
    this.token++;
    if (this.controlled) this.halt();
    this.ep = undefined;
    this.yieldControl();
  }

  protected override reset(): void {
    this.ep = undefined;
  }

  behaviour(): string {
    const ep = this.ep;
    if (!ep) return `guarding r=${this.c.guardRadius}`;
    if (ep.phase === 'hold') return `holding the work: ${bareType(ep.type)} fought and not dead`; // Track M11
    return ep.phase === 'collect' ? 'collecting drops' : `fighting ${bareType(ep.type)}${ep.inPlace ? ' (in place)' : ''}`;
  }

  status(): ProcessStatus {
    return { line: this.ep ? `guard: ${this.behaviour()}` : `guard ${this.c.guard.on ? `on r=${this.c.guardRadius}` : 'off'}` };
  }
}

/**
 * Trip readiness for the user processes (Track W, tasks/process/readiness.ts): at every (re)start a
 * trip of more than 16 blocks first eats to full and puts on armour when food or health is below 14
 * (`preparing: eating` in the status line), then the real work starts.
 */
class TripPrep {
  /** The current preparation phase (undefined when not preparing). */
  phase: PrepPhase | undefined;
  /** Preparations run (for tests and the status). */
  runs = 0;
  private readonly c: PveController;

  constructor(c: PveController) {
    this.c = c;
  }

  /** Start `go` now, or after the preparation when the trip to `to` needs one; `alive` = still the same run. */
  start(to: Vec3 | undefined, alive: () => boolean, go: () => void): void {
    if (!this.c.prepNeeded(to)) {
      go();
      return;
    }
    this.runs++;
    this.phase = 'eating';
    void this.c
      .prepare(
        alive,
        (p) => {
          this.phase = p;
        },
        to,
      )
      .catch((e: unknown) => {
        this.c.log.warn(`trip: preparing failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .then(() => {
        this.phase = undefined;
        if (alive()) go();
      });
  }

  line(): string | undefined {
    return this.phase ? `preparing: ${this.phase}` : undefined;
  }
}

/** !follow: until stopped; pre-empted = the follower stops, resumed = it starts again. */
class FollowProcess extends BaseProcess {
  readonly name = 'follow';
  readonly kind = 'user' as const;
  private readonly c: PveController;
  private readonly target: FollowTarget;
  readonly label: string;
  /** `!follow ... now`: the night process yields to it (Track W). */
  readonly urgent: boolean;
  private readonly prep: TripPrep;
  private started = false;
  private readonly off: () => void;

  constructor(c: PveController, target: FollowTarget, label: string, urgent = false) {
    super();
    this.c = c;
    this.target = target;
    this.label = label;
    this.urgent = urgent;
    this.prep = new TripPrep(c);
    // followDistance / sprint changed: start following again with the new values
    this.off = c.settings.onChange((key) => {
      if ((key === 'followDistance' || key === 'sprint') && this.controlled && !this.prep.phase) this.follow();
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  private targetFeet(): Vec3 | undefined {
    if ('playerName' in this.target) return this.c.playerFeet(this.target.playerName);
    const e = this.c.d.world.entities.get(this.target.runtimeId);
    return e ? entityFeet(e) : undefined;
  }

  protected run(t: number): void {
    // only the start of a follow is a trip (later legs are short by nature)
    if (this.started) {
      this.follow();
      return;
    }
    this.prep.start(this.targetFeet(), () => t === this.token, () => {
      this.started = true;
      this.follow();
    });
  }

  private follow(): void {
    const s = this.c.settings;
    void this.c.follower.follow(this.target, { stopDistance: s.get('followDistance'), sprintDistance: s.get('sprint') ? 8 : Infinity });
  }

  protected halt(): void {
    this.c.follower.stop();
  }

  protected override onStopped(): void {
    this.off();
  }

  behaviour(): string {
    return this.prep.line() ?? `following ${this.label}`;
  }

  status(): ProcessStatus {
    const p = this.prep.line();
    if (p) return { line: `${p} (then following ${this.label})` };
    const st = this.c.follower.status();
    return { line: `following ${this.label}${this.controlled && st.distance !== null ? `, ${st.distance.toFixed(1)} blocks away (${st.state})` : ''}` };
  }
}

/** !come: one walk to within 2 blocks of the player's position when it (re)starts. */
class ComeProcess extends BaseProcess {
  readonly name = 'come';
  readonly kind = 'user' as const;
  readonly result: Promise<SkillResult>;
  /** `!come now`: the night process yields to it (Track W). */
  readonly urgent: boolean;
  private resolve!: (r: SkillResult) => void;
  private readonly c: PveController;
  private readonly who: string;
  private readonly prep: TripPrep;
  /** Where the player was last tracked or reported (Track W). */
  private lastKnown: Vec3 | undefined;

  constructor(c: PveController, who: string, urgent = false) {
    super();
    this.c = c;
    this.who = who;
    this.urgent = urgent;
    this.prep = new TripPrep(c);
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    this.prep.start(this.c.playerFeet(this.who), () => t === this.token, () => {
      this.leg(t, 0);
    });
  }

  /**
   * One leg: to the tracked player (the follower's come), or, beyond the entity range, towards the
   * locator bar's position (Track W) and then on to the tracked player once it is in range.
   */
  private leg(t: number, n: number): void {
    const c = this.c;
    const done = (r: SkillResult) => {
      if (t !== this.token) return;
      this.finish();
      this.resolve(r);
    };
    const tracked = c.trackedPlayerFeet(this.who);
    if (tracked) {
      this.lastKnown = tracked;
      void c.follower.come(this.who).then(done);
      return;
    }
    // beyond the entity range: the locator bar, else where the player was last seen (a flight may take
    // the bot out of range of a player standing still, whom the bar then does not report again)
    const far = c.locator.find(this.who)?.feet ?? this.lastKnown;
    if (!far || n >= 4) {
      done({ ok: false, reason: 'not_found' });
      return;
    }
    this.lastKnown = far;
    c.log.info(`come: ${this.who} is beyond the entity range; walking to the last known position ${far.x.toFixed(1)} ${far.y.toFixed(1)} ${far.z.toFixed(1)}`);
    void c.mover.goto({ type: 'near', p: { x: far.x, y: Math.round(far.y), z: far.z }, r: 2 }, { timeoutTicks: 2400, sprint: true }).then((r) => {
      if (t !== this.token) return;
      if (!r.ok && !c.trackedPlayerFeet(this.who)) {
        done(r);
        return;
      }
      this.leg(t, n + 1); // tracked now (or there): the last stretch to where the player really is
    });
  }

  protected halt(): void {
    this.c.follower.stop();
    if (this.c.mover.nav.busy) this.c.mover.cancel();
  }

  protected override onStopped(_reason: StopReason): void {
    this.resolve({ ok: false, reason: 'interrupted' });
  }

  behaviour(): string {
    return this.prep.line() ?? `coming to ${this.who}`;
  }

  status(): ProcessStatus {
    const p = this.prep.line();
    if (p) return { line: `${p} (then coming to ${this.who})` };
    const left = this.controlled ? navRemaining(this.c.mover.nav, this.c.position()) : undefined;
    return { line: `coming to ${this.who}${left !== undefined ? `, ${Math.round(left)} blocks left` : ''}`, etaS: etaFor(left, this.c.mover.nav.lastReport, this.c.settings.get('sprint')) };
  }
}

/** A goto through the PvE layer (`!goto`, `!home go`, `!top`) that prepares for a trip of more than 16 blocks first (Track W). */
class TripGotoProcess extends GotoProcess {
  private readonly prep: TripPrep;
  private readonly to: Vec3 | undefined;

  constructor(c: PveController, o: GotoProcessOptions) {
    super(o);
    this.prep = new TripPrep(c);
    const g = o.goal as Goal | NavGoal;
    // goals without a place (surface, runAway, ...) are short by nature: no preparation
    this.to = g.type === 'block' || g.type === 'near' ? g.p : g.type === 'xz' ? { x: g.x, y: 0, z: g.z } : g.type === 'getToBlock' ? g.p : undefined;
  }

  protected override run(t: number, resumed: boolean): void {
    if (!this.to) {
      super.run(t, resumed);
      return;
    }
    this.prep.start(this.to, () => t === this.token, () => {
      super.run(t, resumed);
    });
  }

  override behaviour(): string {
    return this.prep.line() ?? super.behaviour();
  }

  override status(): ProcessStatus {
    const p = this.prep.line();
    return p ? { line: `${p} (then ${this.label})` } : super.status();
  }
}

/** !kill <type> [n]: nearest first, picking up drops after each; pre-empted = the fight is cancelled, resumed = next target. */
class KillProcess extends BaseProcess {
  readonly name = 'kill';
  readonly kind = 'user' as const;
  readonly result: Promise<KillResult>;
  private resolve!: (r: KillResult) => void;
  private readonly c: PveController;
  readonly type: string;
  readonly want: number;
  killed = 0;
  private readonly fights: FightResult[] = [];
  /** `!kill ... now`: the night process yields to it (Track W). */
  readonly urgent: boolean;
  private readonly prep: TripPrep;

  constructor(c: PveController, type: string, want: number, urgent = false) {
    super();
    this.c = c;
    this.type = type;
    this.want = want;
    this.urgent = urgent;
    this.prep = new TripPrep(c);
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    // a target beyond 16 blocks is a trip (Track W): prepare first
    const first = this.c.nearestOfType(this.type);
    this.prep.start(first ? entityFeet(first) : this.c.position(), () => t === this.token, () => {
      void this.loop(t);
    });
  }

  private async loop(t: number): Promise<void> {
    const c = this.c;
    let reason: KillResult['reason'] = 'done';
    while (this.killed < this.want) {
      if (t !== this.token) return;
      const target = c.nearestOfType(this.type);
      if (!target) {
        reason = 'none_left';
        break;
      }
      const r = await c.combat.fight(target.runtimeId);
      if (t !== this.token) return;
      this.fights.push(r);
      c.countFight(r);
      if (r.ok) {
        this.killed++;
        await c.mover.collect(c.collectRadius, 200);
        if (t !== this.token) return;
      } else if (r.reason === 'interrupted') {
        return;
      } else {
        c.ignore.set(target.runtimeId, performance.now() + 30_000);
      }
    }
    this.finish();
    this.resolve({ ok: this.killed >= this.want, type: this.type, killed: this.killed, want: this.want, reason, fights: [...this.fights] });
  }

  protected halt(): void {
    const c = this.c;
    if (c.combat.busy) c.combat.cancel();
    if (c.mover.nav.busy) c.mover.cancel();
  }

  protected override onStopped(): void {
    this.resolve({ ok: false, type: this.type, killed: this.killed, want: this.want, reason: 'interrupted', fights: [...this.fights] });
  }

  behaviour(): string {
    const p = this.prep.line();
    if (p) return `${p} (kill ${this.type} ${this.killed}/${this.want})`;
    const tg = this.c.combat.target;
    return `${tg && this.controlled ? `fighting ${bareType(tg.type)}` : 'looking for'} (kill ${this.type} ${this.killed}/${this.want})`;
  }

  status(): ProcessStatus {
    return { line: `kill ${this.type} ${this.killed}/${this.want}` };
  }
}

/**
 * PvE options from the afk task's CLI values (`--guard <radius|on|off>`, `--flee-health <h>`) and its
 * config block (`tasks.afk.guard`: radius, true/false or `{ on, radius }`; `tasks.afk.fleeHealth`).
 * The CLI wins. Throws on nonsense so a typo does not silently leave guard off.
 */
export function pveOptionsFrom(values: Readonly<Record<string, unknown>>, config: Readonly<Record<string, unknown>>): PveOptions {
  const out: PveOptions = {};
  const guard = parseGuard(values.guard ?? config.guard);
  if (guard) out.guard = guard;
  const flee = values['flee-health'] ?? config.fleeHealth;
  if (flee !== undefined) {
    const h = Number(flee);
    if (!Number.isFinite(h) || h < 0 || h > 20) throw new Error(`flee health must be 0..20, got ${show(flee)}`);
    out.fleeHealth = h;
  }
  return out;
}

function parseGuard(v: unknown): Partial<GuardSettings> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return { on: v };
  if (typeof v === 'object') {
    const o = v as { on?: unknown; radius?: unknown };
    return { on: o.on === undefined ? true : o.on === true, ...(o.radius !== undefined ? { radius: guardRadius(o.radius) } : {}) };
  }
  const s = show(v).trim().toLowerCase();
  if (s === 'on' || s === 'true') return { on: true };
  if (s === 'off' || s === 'false') return { on: false };
  return { on: true, radius: guardRadius(s) };
}

function guardRadius(v: unknown): number {
  const r = Number(v);
  if (!Number.isFinite(r) || r < 2 || r > 64) throw new Error(`guard radius must be 2..64, got ${show(v)}`);
  return Math.round(r);
}

function show(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v) ?? 'undefined';
}

/**
 * `!kill` targets that are refused: `player(s)`, selectors, and the name of any tracked player.
 * The combat skill refuses players on its own as well; this gives the owner a clear reply.
 */
export function refusedKillType(type: string, entities: ReadonlyMap<bigint, EntityInfo>): boolean {
  const t = bareType(type);
  if (t === 'player' || t === 'players' || t.startsWith('@')) return true;
  for (const e of entities.values()) {
    if (e.username?.replace(/§./g, '').toLowerCase() === t) return true;
  }
  return false;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Track E7: every cell round the feet and the head is known solid (a shell, a seal): nothing walks up to the body. */
export function walledIn(me: Vec3, grid: targeting.GridLike | undefined): boolean {
  if (!grid) return false;
  const solid = (x: number, y: number, z: number): boolean | undefined => {
    const c = grid.cls(x, y, z);
    return c === undefined ? undefined : c.boxes.length > 0 && c.top >= 1;
  };
  const head = Math.floor(me.y + 1e-3) + 2;
  return sealCells(me, solid).every((c) => c.y >= head);
}
