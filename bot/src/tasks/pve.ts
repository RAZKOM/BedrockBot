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
// - flee: health below `fleeHealth` (default 8) with a hostile alive within 16 blocks -> run to the
//   shelter if one is set, else home; if neither is set or the bot is already there, run 12 blocks
//   straight away from the nearest hostile. While the health stays low the bot only defends in place.
//   Not while night safety is already walking to the shelter (same place; interrupting would count
//   as a failed retreat). A kill job does not survive a flight.
// - guard (when on): the hostile closest to the bot (or the one that hit it in the last 10 s, or one
//   that targets it) within `guardRadius` of the home point (of the bot when no home is set or while
//   a command runs) is fought. Neutral mobs only when they hit or target the bot. Players never. Not
//   while a kill job is the active process (it is fighting already).
// - night: while night safety wants the shelter, inside it the bot only defends in place (85, above
//   the night process); on the way there guard does not interrupt (60 < 80).
// - after a guard fight (not in place) the drops within 8 blocks are picked up; with no command
//   running and a home set, the bot walks home (the home-return process, dropped by any new command).
import type { Metrics } from '../connection/metrics.ts';
import { RuntimeSettings } from '../config/settings.ts';
import { silentLogger, type Logger } from '../log.ts';
import { CombatController, type CombatLoop, type CombatMover, type FightOptions, type FightResult } from '../skills/combat/combat.ts';
import { bareType, classify, entityFeet, isPlayerEntity, MobTracker, typeMatches } from '../skills/combat/hostiles.ts';
import * as targeting from '../skills/combat/targeting.ts'; // Track V: reachability-aware targeting, creeper rank
import { FollowController, type FollowLoop, type FollowTarget } from '../skills/follow/follow.ts';
import type { Goal } from '../skills/nav/goals.ts';
import type { GotoOptions, SkillResult } from '../skills/types.ts';
import { Hotbar } from '../world/hotbar.ts';
import type { Inventory } from '../world/inventory.ts';
import type { EntityInfo, PacketSource, Vec3 } from '../world/types.ts';
import { etaFor, GotoProcess, navRemaining, settingsMover, type ProcessMover } from './process/goto.ts';
import { BaseProcess, PRIORITY, ProcessManager, type ProcessStatus, type StopReason } from './process/manager.ts';

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
}

/** The world model as PvE reads it (`World` satisfies it). */
export interface PveWorld {
  readonly entities: ReadonlyMap<bigint, EntityInfo>;
  readonly inventory: Inventory;
  readonly self: { readonly runtimeId: bigint; readonly health: number };
}

/** The InputLoop as PvE drives it (`InputLoop` satisfies it). */
export type PveLoop = CombatLoop & FollowLoop & { waitTicks?(n: number): Promise<void> };

/** BotSkills as PvE uses it (`BotSkills` satisfies it). */
export interface PveSkills extends CombatMover {
  collect(radius: number, timeoutTicks: number): Promise<unknown>;
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
  private readonly unsubs: (() => void)[] = [];
  readonly stats = { fights: 0, kills: 0, flees: 0, guardTriggers: 0 };

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
    this.unsubs.push(
      this.mobs.onHit((g, damage) => {
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
    this.combat.dispose();
    this.follower.dispose();
    this.mobs.dispose();
    this.hotbar.dispose();
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
  follow(target: FollowTarget): string {
    const label = 'playerName' in target ? target.playerName : `${bareType(this.d.world.entities.get(target.runtimeId)?.type ?? 'entity')} #${target.runtimeId}`;
    this.processes.add(new FollowProcess(this, target, label));
    return label;
  }

  /** Walk to within 2 blocks of the player's current position. */
  come(name: string): Promise<SkillResult> {
    return this.processes.add(new ComeProcess(this, name)).result;
  }

  /** goto as a user process: survives pre-emption (planned again afterwards). */
  walk(goal: Goal, opts: GotoOptions = {}, label?: string): Promise<SkillResult> {
    return this.processes.add(this.gotoProcess(goal, opts, label)).result;
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
  kill(type: string, n: number): Promise<KillResult> {
    if (refusedKillType(type, this.d.world.entities)) {
      return Promise.resolve({ ok: false, type, killed: 0, want: n, reason: 'refused_player', fights: [] });
    }
    const p = this.processes.add(new KillProcess(this, type, n));
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

  fleeTarget(me: Vec3, threat: EntityInfo): { to: Vec3; kind: string } | undefined {
    const shelter = this.d.shelter();
    const home = this.d.home();
    const dest = shelter ?? home;
    if (dest) {
      const c = { x: dest.x + 0.5, y: dest.y, z: dest.z + 0.5 };
      if (Math.hypot(c.x - me.x, c.z - me.z) > 2) return { to: dest, kind: shelter ? 'shelter' : 'home' };
    }
    // nowhere to go, or already there: run 12 blocks away from the threat if it is close
    const f = entityFeet(threat);
    const dx = me.x - f.x;
    const dz = me.z - f.z;
    const d = Math.hypot(dx, dz);
    if (d > 6) return undefined;
    const ux = d > 1e-3 ? dx / d : 1;
    const uz = d > 1e-3 ? dz / d : 0;
    return { to: { x: Math.floor(me.x + ux * 12), y: Math.floor(me.y), z: Math.floor(me.z + uz * 12) }, kind: 'away' };
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

/** Flee (priority 100): run to the shelter / home / away while the health is low with a hostile near. */
class FleeProcess extends BaseProcess {
  readonly name = 'flee';
  readonly kind = 'auto' as const;
  protected override persistent = true;
  private ep: { to: Vec3; kind: string; from: string } | undefined;
  private plan: { to: Vec3; kind: string; threat: EntityInfo } | undefined;
  private cooldownUntil = 0;
  private readonly c: PveController;

  constructor(c: PveController) {
    super();
    this.c = c;
  }

  get priority(): number {
    return PRIORITY.flee;
  }

  override wants(): boolean {
    if (this.ep) return true;
    this.plan = undefined;
    const c = this.c;
    if (!c.low() || performance.now() < this.cooldownUntil || c.d.night?.state === 'going') return false;
    const me = c.position();
    const threat = c.nearestHostile(me, FLEE_SCAN);
    if (!threat) return false;
    const plan = c.fleeTarget(me, threat);
    if (!plan) return false;
    this.plan = { ...plan, threat };
    return true;
  }

  protected run(t: number, resumed: boolean): void {
    const c = this.c;
    if (!this.ep) {
      const plan = this.plan;
      if (!plan) return;
      this.ep = { to: plan.to, kind: plan.kind, from: plan.threat.type };
      c.stats.flees++;
      c.d.metrics?.inc('pve.flees');
      c.log.warn(`flee: health ${c.health()} < ${c.fleeHealth} with ${bareType(plan.threat.type)} near; running to ${plan.kind} ${plan.to.x} ${plan.to.y} ${plan.to.z}`);
      // a kill job does not survive a flight; a guard fight ends
      for (const k of c.processes.find('kill')) c.processes.stop(k, 'stopped');
      c.guardProcess.cancelEpisode();
    } else if (resumed) {
      c.log.info(`flee: resuming to ${this.ep.kind}`);
    }
    const ep = this.ep;
    const goal: Goal = ep.kind === 'away' ? { type: 'near', p: { x: ep.to.x + 0.5, y: ep.to.y, z: ep.to.z + 0.5 }, r: 2 } : { type: 'block', p: ep.to };
    void c.mover.goto(goal, { timeoutTicks: 1200, sprint: true }).then((r) => {
      if (t !== this.token) return;
      c.log.info(`flee: ${r.ok ? 'arrived' : r.reason}`);
      this.ep = undefined;
      this.cooldownUntil = performance.now() + 10_000;
    });
  }

  protected halt(): void {
    if (this.c.mover.nav.busy) this.c.mover.cancel();
  }

  cancelEpisode(): void {
    if (!this.ep) return;
    this.token++;
    if (this.controlled && this.c.mover.nav.busy) this.c.mover.cancel();
    this.ep = undefined;
    this.yieldControl();
  }

  protected override reset(): void {
    this.ep = undefined;
  }

  behaviour(): string {
    return 'fleeing';
  }

  status(): ProcessStatus {
    const ep = this.ep;
    if (!ep) return { line: 'flee: watching' };
    const left = this.controlled ? navRemaining(this.c.mover.nav, this.c.position()) : undefined;
    return { line: `fleeing to ${ep.kind} ${ep.to.x} ${ep.to.y} ${ep.to.z}${left !== undefined ? `, ${Math.round(left)} blocks left` : ''}`, etaS: etaFor(left, this.c.mover.nav.lastReport, true) };
  }
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
      targeting.afterFight(c, e, r); // Track V: 10 s for out_of_range / unreachable, none for creeper_avoided / interrupted
      if (r.ok && !inPlace) {
        ep.phase = 'collect';
        await c.mover.collect(c.collectRadius, 200);
        if (t !== this.token) return;
      }
      this.ep = undefined;
      // back home when nothing else is queued (and no night shelter wanted); another threat goes first (60 > 20)
      if (!inPlace && !c.d.night?.wantsShelter()) {
        const home = c.d.home();
        const me = c.position();
        if (home && dist(me, { x: home.x + 0.5, y: home.y, z: home.z + 0.5 }) > 1.5) void c.returnHome('guard', { timeoutTicks: 2400, ifIdle: true });
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

/** !follow: until stopped; pre-empted = the follower stops, resumed = it starts again. */
class FollowProcess extends BaseProcess {
  readonly name = 'follow';
  readonly kind = 'user' as const;
  private readonly c: PveController;
  private readonly target: FollowTarget;
  readonly label: string;
  private readonly off: () => void;

  constructor(c: PveController, target: FollowTarget, label: string) {
    super();
    this.c = c;
    this.target = target;
    this.label = label;
    // followDistance / sprint changed: start following again with the new values
    this.off = c.settings.onChange((key) => {
      if ((key === 'followDistance' || key === 'sprint') && this.controlled) this.run();
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(): void {
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
    return `following ${this.label}`;
  }

  status(): ProcessStatus {
    const st = this.c.follower.status();
    return { line: `following ${this.label}${this.controlled && st.distance !== null ? `, ${st.distance.toFixed(1)} blocks away (${st.state})` : ''}` };
  }
}

/** !come: one walk to within 2 blocks of the player's position when it (re)starts. */
class ComeProcess extends BaseProcess {
  readonly name = 'come';
  readonly kind = 'user' as const;
  readonly result: Promise<SkillResult>;
  private resolve!: (r: SkillResult) => void;
  private readonly c: PveController;
  private readonly who: string;

  constructor(c: PveController, who: string) {
    super();
    this.c = c;
    this.who = who;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    void this.c.follower.come(this.who).then((r) => {
      if (t !== this.token) return;
      this.finish();
      this.resolve(r);
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
    return `coming to ${this.who}`;
  }

  status(): ProcessStatus {
    const left = this.controlled ? navRemaining(this.c.mover.nav, this.c.position()) : undefined;
    return { line: `coming to ${this.who}${left !== undefined ? `, ${Math.round(left)} blocks left` : ''}`, etaS: etaFor(left, this.c.mover.nav.lastReport, this.c.settings.get('sprint')) };
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

  constructor(c: PveController, type: string, want: number) {
    super();
    this.c = c;
    this.type = type;
    this.want = want;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    void this.loop(t);
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
