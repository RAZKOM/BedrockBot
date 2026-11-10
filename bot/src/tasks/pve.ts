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
import { bladeScore, CombatController, type CombatLoop, type CombatMover, type FightOptions, type FightResult } from '../skills/combat/combat.ts';
import { bareType, classify, entityFeet, isPlayerEntity, MobTracker, typeMatches } from '../skills/combat/hostiles.ts';
import * as targeting from '../skills/combat/targeting.ts'; // Track V: reachability-aware targeting, creeper rank
import { PathReach, probeNavOf } from '../skills/combat/pathReach.ts'; // Track AO: path-reachable guard targets
import { Reflex } from '../skills/combat/reflex.ts'; // Track M1: the always-on strike layer
import { dodgeStep, POTION_STEP_TICKS, potionSideStep, type DodgeShooter } from '../skills/combat/dodge.ts'; // Track M1 round 2: across the line of fire
import { canSealHere, seal, openSide, type SealDeps } from '../skills/survival/seal.ts'; // Track M1: the last floor
import { FollowController, type FollowLoop, type FollowTarget } from '../skills/follow/follow.ts';
import type { Goal, NavGoal } from '../skills/nav/goals.ts';
import type { GotoOptions, SkillResult } from '../skills/types.ts';
import { headInWater } from '../skills/survival/surface.ts'; // Track BF
import { chooseFood } from '../skills/survival/eat.ts'; // Track M1: the eat floor
import { Hotbar } from '../world/hotbar.ts';
import type { Inventory } from '../world/inventory.ts';
import type { EntityInfo, PacketSource, Vec3 } from '../world/types.ts';
import { etaFor, GotoProcess, navRemaining, settingsMover, type GotoProcessOptions, type ProcessMover } from './process/goto.ts';
import { BaseProcess, PRIORITY, ProcessManager, type ProcessStatus, type StopReason } from './process/manager.ts';
import { checkTrip, longTrip, needsPrep, prepareTrip, type PrepPhase, type TripCheck, type TripKit } from './process/readiness.ts'; // Track W
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
/** A hard trigger with the threat this close ignores the cooldown after a flight (immediate danger). */
export const FLEE_URGENT = 6;
/** After a flight, keep away from hostiles until the health is back to fleeHealth + this (for up to FLEE_RECOVER_MS). */
export const FLEE_RECOVER = 6;
const FLEE_RECOVER_MS = 60_000;
/** While recovering, a melee hostile this close starts a flight. */
const FLEE_RECOVER_SCAN = 12;
/** Ranged mobs: running from them in a line only gives them targets; not a reason for a recovery flight. */
export const FLEE_RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'witch', 'ghast', 'drowned', 'evocation_illager', 'evoker']);
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
/** Sealed in: open up again once the health is back to this and no mob is within 16 or it is day (at most after SEAL_MAX_MS). */
export const SEAL_LEAVE_HEALTH = 20;
const SEAL_MAX_MS = 300_000;
/** A potion's level motion within this angle's cosine of the line to the bot is coming at it (about 50 degrees: she aims where the bot was). */
const POTION_AIM_COS = 0.65;
/** Builds of a surface shell before the bot settles in it as it is (the second from where the body is then). */
const SEAL_TRIES = 2;
/** Archers a lone duel closes in on (Track M1): running in the open from one keeps the bot in its range. */
export const DUEL_ARCHERS = new Set(['skeleton', 'stray', 'bogged', 'pillager']);
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
/** The dodge (mobDodge, no blade): shooters within this (and in sight) are dodged; a melee mob within DODGE_MELEE ends it. */
export const DODGE_RANGE = 16;
export const DODGE_MELEE = 6;

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
  /** The elytra flee can go now (setting on, kit ready, a home, not tried within FLOOR_RETRY_MS). */
  fly: boolean;
  /** The seal-in can go now (setting on, enough blocks, a placer, not tried within FLOOR_RETRY_MS). */
  seal: boolean;
}

/**
 * The health rule, in order: no danger (or a duel that is worth it): fight on; clear of every mob by FLEE_EAT_CLEAR with
 * food to eat: eat; else back off (the flight on foot, the reflex striking behind) unless running has failed (caught,
 * cornered) or the health is critical next to a melee mob; then the elytra flee, then the seal-in, then defend in place.
 */
export function pveFloor(i: FloorInput): Floor {
  if (!i.danger || i.canDuel) return 'fight';
  if (i.nearest >= FLEE_EAT_CLEAR && i.hasFood && i.food < 20 && i.health < 20) return 'eat';
  if (!i.failed && !i.critical) return 'backoff';
  if (i.fly) return 'fly';
  if (i.seal) return 'seal';
  return 'defend';
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
  /** Track AO: why and since when each ignored mob is ignored (status, the hit rule). */
  readonly ignoreWhy = new Map<bigint, targeting.IgnoreNote>();
  /** Track AO: bounded probe plans to guard candidates (cached per mob for 5 s). */
  readonly pathReach: PathReach;
  private readonly unsubs: (() => void)[] = [];
  readonly stats = { fights: 0, kills: 0, flees: 0, guardTriggers: 0 };
  /** The survival kit (eat, equip) for flee eating and trip readiness; wired by chat/commands-pve.ts (Track W). */
  kit: (() => TripKit | undefined) | undefined;
  /** The last hit the bot took (Track W: how many more it can take). */
  lastHit: { damage: number; at: number } | undefined;
  private readonly recentHits: { damage: number; at: number }[] = [];
  /** Far players from the locator bar (Track W): `!come` beyond the entity range. */
  readonly locator: PlayerLocator;
  /** Track M1: strikes every hostile within reach under every activity (the `mobReflex` setting). */
  readonly reflex: Reflex;
  /** Track M1: hits taken by mob type (the attacker guess; `unknown` without one), for !pve and the counters. */
  readonly taken: Record<string, number> = {};
  /** Track M1: the floors taken (backoff, eat, fly, seal, defend), for the counters. */
  readonly floors: Record<string, number> = {};
  /**
   * Track M1: the elytra flee (wired by chat/commands-pve.ts: `!fly home` as the owner's command, through the flight
   * skill's own entry point). `ready` says whether it can go now (kit, a home); `go` dispatches it (true when sent).
   */
  flyHome: { ready(): boolean; go(): boolean } | undefined;

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
      enabled: () => this.settings.get('mobReflex') && !deps.inactive() && this.processes.active?.name !== 'flight',
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
    this.unsubs.push(loop.onBeforeStep(() => this.idleBlock())); // Track M1 round 2: the shield while idle
    this.unsubs.push(loop.onBeforeStep(() => this.noteWitchThrows())); // Track M1 round 2: the witch's throw window
    this.unsubs.push(loop.onBeforeStep(() => this.potionStep())); // Track M1 round 2: out from under her potion
    this.unsubs.push(
      this.mobs.onHit((g, damage, cause) => {
        if (cause === 'drowning') {
          // Track BF: not a fight (no duel rule, no flee from a mob); the air came from the server's `air` value when it sent one
          const air = this.mobs.selfAir;
          this.log.info(`pve: took ${damage.toFixed(1)} damage (drowning: head under water${air !== undefined ? `, air ${air}` : ''}), health ${this.health()}`);
          return;
        }
        if (damage > 0) {
          // Track M1: hits taken by type (the owner's counters)
          const k = g ? bareType(g.type) : 'unknown';
          this.taken[k] = (this.taken[k] ?? 0) + 1;
          this.d.metrics?.inc(`pve.taken.${k}`);
          // Track W: the duel rule
          this.lastHit = { damage, at: performance.now() };
          this.recentHits.push(this.lastHit);
          if (this.recentHits.length > 20) this.recentHits.shift();
        }
        this.log.info(`pve: took ${damage.toFixed(1)} damage${g ? ` (probably ${bareType(g.type)} #${g.runtimeId}, ${g.why})` : ''}, health ${this.health()}`);
      }),
    );
  }

  dispose(): void {
    this.stop();
    this.processes.stop(this.fleeProcess);
    this.processes.stop(this.guardProcess);
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
    this.processes.stopUser(['home']);
    this.guardProcess.cancelEpisode();
    this.fleeProcess.cancelEpisode();
    return was;
  }

  /** `!stop`: every command and what it pre-empted, plus a pending home return; guard, flee and night keep running. */
  stopCommands(): string {
    const lines = this.processes.stopUser(['home']);
    return lines.length ? lines.join(', ') : this.behaviour();
  }

  /** On death: drop the commands that do not survive it (gather does), the episodes and a home return (guard settings stay). */
  onDeath(): void {
    this.processes.onDeath(['home']);
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
    return this.kit?.() !== undefined && longTrip(this.position(), to) && needsPrep({ food: this.food(), health: this.health() });
  }

  /** Eat to full and put on armour (see readiness.ts); resolves at once when there is nothing to do. */
  async prepare(alive: () => boolean, phase: (p: PrepPhase) => void): Promise<void> {
    const kit = this.kit?.();
    if (!kit) return;
    const self = { food: this.food(), health: this.health() };
    Object.defineProperties(self, { food: { get: () => this.food() }, health: { get: () => this.health() } });
    const loop = this.d.loop;
    const r = await prepareTrip(kit, self, { alive, phase, wait: (n) => (loop.waitTicks ? loop.waitTicks(n) : new Promise((res) => setTimeout(res, n * 50))) });
    this.log.info(`trip: prepared (${r.bites} bites, food ${r.foodBefore} -> ${r.foodAfter}${r.equipped.length ? `, wearing ${r.equipped.join(', ')}` : ''}; ${r.stop})`);
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

  /** Low health: below fleeHealth (and alive). */
  low(): boolean {
    const h = this.health();
    return h > 0 && h < this.fleeHealth;
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

  /** Track M1: a sword or an axe in the hotbar. */
  hasBlade(): boolean {
    return this.d.world.inventory.slots.slice(0, 9).some((it) => !!it && it.count > 0 && bladeScore(it) > 0);
  }

  /**
   * Track M1: the witch goes first (guard's rank, targeting.ts firstTarget). Measured on BDS (ADR 0079): her harming potion is
   * 6 whatever the armour, her poison 1 every 25 ticks for 45 s, a throw every 61 ticks from 8 blocks (none from 12, held in
   * place), and the netherite sword kills her in 3 hits, 1.7 s from 5 blocks (sprint hits the same, critical hits 2.1 s). So
   * with a blade, at WITCH_ENGAGE_HEALTH or more (one potion on the way still leaves health), within WITCH_FIRST_RANGE, in
   * sight, and the way to her clear of other melee mobs (none within WITCH_WAY_CLEAR of the line beyond the bot's own reach).
   */
  firstTarget(e: EntityInfo, me: Vec3): boolean {
    if (bareType(e.type) !== 'witch' || this.mobs.get(e.runtimeId)?.dead || !this.hasBlade()) return false;
    const f = entityFeet(e);
    const d = dist(f, me);
    if (d > WITCH_FIRST_RANGE) return false;
    // Within WITCH_CLOSE (her throw range) at any health: a run does not get out of her range before her next throw (she
    // follows; three round-2 mixed-8 deaths ran from her at 6 to 7 blocks and 3 to 7 health, her one hit from dead, and her
    // harming came from 9 to 11). Farther, at low health, only just after a throw: she cannot throw again for about 3 s
    if (d > WITCH_CLOSE && this.health() < WITCH_ENGAGE_HEALTH && !this.witchJustThrew(e.runtimeId)) return false;
    const grid = targeting.gridOf(this.mover);
    if (grid && !targeting.lineOfSight(grid, { x: me.x, y: me.y + 1.62, z: me.z }, e)) return false;
    const len = Math.hypot(f.x - me.x, f.z - me.z);
    if (len < 1e-3) return true;
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
   * Why the bot must flee now, if it must: `low` (health below fleeHealth with a hostile within 16) or
   * `creeper` (a creeper within 6 and health below 10, whatever fleeHealth says). At the shelter /
   * home a flight starts only when the threat is within 6 (inside, guard defends in place).
   */
  fleeReason(me: Vec3): { why: 'low' | 'creeper'; threat: EntityInfo } | undefined {
    const h = this.health();
    if (h <= 0) return undefined;
    let out: { why: 'low' | 'creeper'; threat: EntityInfo } | undefined;
    if (h < FLEE_CREEPER_HEALTH) {
      const cr = this.creeperNear(me);
      if (cr) out = { why: 'creeper', threat: cr };
    }
    out ??= ((t) => (t ? { why: 'low' as const, threat: t } : undefined))(targeting.crowdThreat(this, me)); // Track AH: crowd rule (3+ melee within 4, health < 12), like a creeper
    // Track M1 round 2: a witch the bot fights first (firstTarget) is not run from at low health (she follows and throws)
    const witchFirst = !out && this.hasBlade() ? this.nearestOfKind(me, WITCH_FIRST_RANGE, (t) => t === 'witch') : undefined;
    if (witchFirst && this.firstTarget(witchFirst, me)) return undefined;
    if (!out && this.low() && !this.canDuel(me)) {
      const t = this.nearestHostile(me, FLEE_SCAN);
      if (t) out = { why: 'low', threat: t };
    }
    // Track M1: a witch's harming potion is 6 at once on top of its poison: below WITCH_FLEE_HEALTH a bot with no blade
    // runs from a witch within FLEE_SCAN (the bare gauntlet's witch killed the bot from 8 health through one flight; with
    // a sword the fight is better: the live kit's mixed 8 died once running from it through the crowd, ADR 0079)
    if (!out && h < WITCH_FLEE_HEALTH && !this.hasBlade()) {
      const w = this.nearestOfKind(me, FLEE_SCAN, (t) => t === 'witch');
      if (w) out = { why: 'low', threat: w };
    }
    if (out && this.atFleeDest(me) && dist(entityFeet(out.threat), me) > 6) out = undefined;
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
    return this.health() > (archer ? 2 : 3) * Math.max(hit, 1);
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

  /** Track M1 round 2: archers and witches within r (feet) with a line on the bot. */
  shootersWithin(me: Vec3, r: number): number {
    const grid = targeting.gridOf(this.mover);
    const eye = { x: me.x, y: me.y + 1.62, z: me.z };
    let n = 0;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e) || this.mobs.get(e.runtimeId)?.dead) continue;
      const t = bareType(e.type);
      if (!DUEL_ARCHERS.has(t) && t !== 'witch') continue;
      if (dist(entityFeet(e), me) > r || (grid && !targeting.lineOfSight(grid, eye, e))) continue;
      n++;
    }
    return n;
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
  private ep: { why: 'low' | 'creeper'; from: string; start: Vec3; startAt: number; phase: 'away' | 'home' | 'far' | 'seal' | 'sealed' | 'dodge'; dest: { to: Vec3; kind: string } | undefined; safeSince: number | undefined; planAt: number; goalKey: string; bites: number; stallUntil: number; cornered: boolean; planNearest: number; panics: number; caughtSince: number | undefined; sealedAt?: number; dugIn?: boolean; seal?: { placed: number; open: number; reason?: string; tries: number; openCells?: Vec3[] }; dodge?: { dir: 1 | -1; sinceFlip: number; seen: Set<bigint>; lastShot: number; t: number; clearSince: number | undefined } } | undefined;
  private plan: { why: 'low' | 'creeper'; threat: EntityInfo } | undefined;
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
    const late = failed || critical; // fly / seal are looked at only then (an inventory scan)
    const clear = c.eatClearance(me, nearest);
    return pveFloor({
      danger,
      canDuel: c.canDuel(me),
      nearest: clear,
      health: c.health(),
      food: c.food(),
      hasFood: clear >= FLEE_EAT_CLEAR ? c.hasFood() : false,
      failed,
      critical,
      fly: late && c.settings.get('fleeFly') && now - this.flyAt > FLOOR_RETRY_MS && (c.flyHome?.ready() ?? false),
      seal: late && now - this.sealAt > FLOOR_RETRY_MS && c.canSeal(),
    });
  }

  /** Track M1: the elytra flee: `!fly home` through the flight skill's own command (it takes over at flee + 1). */
  private flyNow(why: string): void {
    const c = this.c;
    this.flyAt = performance.now();
    c.floorUsed('fly');
    const sent = c.flyHome?.go() ?? false;
    c.log.warn(`floor: elytra flee home (${why}, health ${c.health().toFixed(1)})${sent ? '' : ': could not send !fly home'}`);
    for (const k of c.processes.find('kill')) c.processes.stop(k, 'stopped');
    c.guardProcess.cancelEpisode();
  }

  override wants(): boolean {
    if (this.ep) return true;
    this.plan = undefined;
    const c = this.c;
    if (c.d.night?.state === 'going') return false;
    const me = c.position();
    // A hard trigger (health below fleeHealth, a creeper near at low health) with the threat within 6 blocks,
    // away from home / the shelter, ignores the cooldown after a flight: a zombie that catches up with the bot
    // at 7 health must not get 10 s of "defending in place" in the open (gaunt-flee ring 2). At the destination,
    // with the threat farther off, and after a cornered end, the cooldown holds and guard defends in place;
    // recovery flights always wait it out.
    let r = c.fleeReason(me);
    // Track M1: running has failed (caught, cornered) or the health is critical next to a melee mob: the elytra flee or the
    // seal-in when they can go (whatever the cooldown says), else guard defends in place as before
    if (r && (performance.now() - this.failedAt < FLOOR_FAILED_MS || (c.critical(me)))) {
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
      if (t && !FLEE_RANGED.has(bareType(t.type)) && !c.canDuel(me) && !(c.atFleeDest(me) && dist(entityFeet(t), me) > 6)) r = { why: 'low', threat: t };
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
        this.flyNow(`${performance.now() - this.failedAt < FLOOR_FAILED_MS ? 'running failed' : 'health critical'} with ${bareType(plan.threat.type)} at ${dist(entityFeet(plan.threat), me).toFixed(1)}`);
        this.yieldControl();
        return;
      }
      this.ep = { why: plan.why, from: plan.threat.type, start: { ...me }, startAt: performance.now(), phase: mode === 'seal' ? 'seal' : 'away', dest: c.fleeTarget(me), safeSince: undefined, planAt: 0, goalKey: '', bites: 0, stallUntil: 0, cornered: false, planNearest: Infinity, panics: 0, caughtSince: undefined };
      c.stats.flees++;
      c.d.metrics?.inc('pve.flees');
      c.floorUsed(mode === 'seal' ? 'seal' : 'backoff'); // Track M1
      events.emit('combat.flee', { why: plan.why, from: bareType(plan.threat.type), health: Math.round(c.health() * 10) / 10 }); // decision 0059
      this.cornered = false;
      this.recoverTo = Math.min(20, c.fleeHealth + FLEE_RECOVER);
      this.recoverUntil = performance.now() + FLEE_RECOVER_MS;
      c.log.warn(
        `flee: ${plan.why === 'creeper' ? `creeper within ${FLEE_CREEPER_RANGE}` : c.low() ? `health ${c.health().toFixed(1)} < ${c.fleeHealth}` : `recovering (health ${c.health().toFixed(1)} < ${this.recoverTo})`} with ${bareType(plan.threat.type)} at ${dist(entityFeet(plan.threat), me).toFixed(1)}; running away${this.ep.dest ? `, then to ${this.ep.dest.kind} ${this.ep.dest.to.x} ${this.ep.dest.to.y} ${this.ep.dest.to.z} when clear` : ''}`,
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
        this.flyNow('health critical while running');
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
    const danger = reason !== undefined || (!c.canDuel(me) && ((c.low() && nearest <= FLEE_SCAN) || (this.recovering() && this.meleeNear(me))));
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
      this.end('gave up (60 s)', 2000);
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
    let phase: 'away' | 'home' | 'far';
    if (dest && (nearest >= FLEE_AWAY || ep.phase === 'home') && (homeClear(me, dest.to, threats) || ep.cornered || safeNow)) phase = 'home';
    else if (nearest >= FLEE_AWAY || ep.phase === 'far') phase = 'far';
    else phase = 'away';
    if (phase === 'far' && dest && dist(ep.start, me) >= FLEE_FAR && nearest >= FLEE_AWAY) phase = 'home'; // far enough: home around the threat
    if (phase !== ep.phase) c.log.info(`flee: ${ep.phase} -> ${phase}${phase === 'home' && dest ? ` (${dest.kind} clear)` : ''}, nearest threat ${nearest === Infinity ? '-' : nearest.toFixed(1)}`);
    ep.phase = phase;
    // (re)plan: a new leg, the last walk ended, or (checked every 2 s while running away) the nearest
    // threat gained on us since the plan. A plan that still works is kept: every new goto stops the body
    // for a moment, and a chasing zombie is almost as fast as a sprinting bot.
    const key = phase === 'home' && dest ? `home:${dest.to.x},${dest.to.y},${dest.to.z}` : phase;
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
        : { type: 'runAway', from: () => c.threatsNear(c.position(), FLEE_SCAN + 8), r: phase === 'far' ? Math.min(FLEE_FAR, Math.max(FLEE_AWAY + 4, nearest + 6)) : FLEE_AWAY + 4 };
    const id = ++this.gotoId;
    this.walking = true;
    void c.mover.goto(goal as Goal, { timeoutTicks: 1200, sprint: true }).then((r) => {
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
        if (e.phase === 'far' && r.reason === 'unreachable') e.cornered = true; // no farther place: home around the threat next
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
    const hungry = c.health() < FLEE_EAT_BELOW || (this.recovering() && c.food() < 18);
    if (!kit || !ep || !hungry || nearest < FLEE_EAT_CLEAR || c.food() >= 20) return;
    if ((kit as { busy?: boolean }).busy) return;
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
  private ep: { e: EntityInfo; type: string; inPlace: boolean; phase: 'fight' | 'collect' } | undefined;
  private pick: { e: EntityInfo; inPlace: boolean } | undefined;
  private readonly c: PveController;

  constructor(c: PveController) {
    super();
    this.c = c;
  }

  get priority(): number {
    return (this.ep?.inPlace ?? this.pick?.inPlace) ? PRIORITY.defend : PRIORITY.guard;
  }

  override wants(): boolean {
    if (this.ep) return true;
    this.pick = undefined;
    const c = this.c;
    // a kill job fights already (unless !pause holds it)
    if (!c.guard.on || (!c.processes.paused && c.processes.find('kill').length > 0)) return false;
    c.pathReach.prune(); // Track AO: drop stale probe verdicts
    this.pick = c.pickThreat(c.position(), c.low());
    return this.pick !== undefined;
  }

  protected run(t: number): void {
    const c = this.c;
    const pick = this.pick;
    if (!pick) return;
    const { e, inPlace } = pick;
    const ep = { e, type: e.type, inPlace, phase: 'fight' as 'fight' | 'collect' };
    this.ep = ep;
    c.stats.guardTriggers++;
    c.d.metrics?.inc('pve.guard');
    c.log.info(`guard: ${bareType(e.type)} #${e.runtimeId} ${inPlace ? 'within reach (defending in place)' : `within ${c.guardRadius} blocks`}, fighting`);
    const opts: FightOptions = inPlace ? { approach: false, maxRange: 5, outOfRangeTicks: 20, timeoutTicks: 600 } : { maxRange: c.guardRadius + CHASE_EXTRA };
    void c.combat.fight(e.runtimeId, opts).then(async (r) => {
      if (t !== this.token) return;
      c.countFight(r);
      targeting.afterFight(c, e, r); // Track V: 10 s for out_of_range, none for creeper_avoided / interrupted; Track AO: 30 s for unreachable, with the reason
      if (r.reason === 'unreachable') c.pathReach.forget(e.runtimeId); // Track AO: probe it afresh after the ignore
      // Track M1 round 2: the drops only with no other hostile within 16 (the collect walk ran 11 s next to a witch at 4.5
      // and a spider at 2 with no fight, a live-kit mixed-8 death with the reflex off)
      if (r.ok && !inPlace && !c.otherThreatWithin(c.position(), 16, e.runtimeId)) {
        ep.phase = 'collect';
        await c.mover.collect(c.collectRadius, 200);
        if (t !== this.token) return;
      }
      this.ep = undefined;
      // back home when nothing else is queued (and no night shelter wanted); another threat goes first (60 > 20)
      if (!inPlace && !c.d.night?.wantsShelter()) {
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
      .prepare(alive, (p) => {
        this.phase = p;
      })
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
