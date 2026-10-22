// PvE behaviours on the AFK task (PLAN.md tasks 7.4 to 7.6, docs/pve.md): guard, flee, follow, come,
// kill, and a resumable goto. PvE ONLY: nothing here ever targets a player (the combat skill refuses
// players itself, and every target list below skips them).
//
// Two layers:
// - the foreground behaviour, chosen by the owner: idle | follow <target> | come <player> |
//   walk <goal> (!goto, !home go, the return home after a guard fight) | kill <type> [n];
// - an episode that interrupts it: a guard fight (fight, then pick up the drops within 8 blocks) or a
//   flight. When the episode ends and no other threat is in range, the foreground is resumed (follow
//   again, re-issue the goto); an idle bot with a home walks back home.
//
// Rules, evaluated every 5 ticks:
// - flee: health below `fleeHealth` (default 8) with a hostile alive within 16 blocks -> run to the
//   shelter if one is set, else home; if neither is set or the bot is already there, run 12 blocks
//   straight away from the nearest hostile. While the health stays low the bot only defends in place.
// - guard (when on): the hostile closest to the bot (or the one that hit it in the last 10 s, or one
//   that targets it) within `radius` of the home point (of the bot when no home is set or while
//   following someone) is fought. Neutral mobs only when they hit or target the bot. Players never.
// - night shelter cooperation: while night safety wants the shelter, the shelter wins. Inside it the
//   bot only defends in place (hostiles within reach, no walking); on the way there guard does not
//   interrupt. While a behaviour here owns the movement, night safety pauses (tasks/registry.ts
//   passes `ownsMovement()` to its `inactive` option), so the two never fight over the navigator.
import type { Metrics } from '../connection/metrics.ts';
import { silentLogger, type Logger } from '../log.ts';
import { CombatController, EYE_HEIGHT, type CombatLoop, type CombatMover, type FightOptions, type FightResult } from '../skills/combat/combat.ts';
import { bareType, classify, entityFeet, isPlayerEntity, MobTracker, reachDistance, typeMatches } from '../skills/combat/hostiles.ts';
import { FollowController, type FollowLoop, type FollowTarget } from '../skills/follow/follow.ts';
import type { Goal } from '../skills/nav/goals.ts';
import type { GotoOptions, SkillResult } from '../skills/types.ts';
import { Hotbar } from '../world/hotbar.ts';
import type { Inventory } from '../world/inventory.ts';
import type { EntityInfo, PacketSource, Vec3 } from '../world/types.ts';

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
}

type Foreground =
  | { kind: 'idle' }
  | { kind: 'follow'; target: FollowTarget; label: string }
  | { kind: 'come'; name: string; done: (r: SkillResult) => void }
  | { kind: 'walk'; goal: Goal; opts: GotoOptions; label: string; done: (r: SkillResult) => void }
  | { kind: 'kill'; type: string; want: number; killed: number; done: (r: KillResult) => void };

type Episode = { kind: 'guard'; type: string; phase: 'fight' | 'collect'; inPlace: boolean } | { kind: 'flee'; to: Vec3; from: string };

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
const STEP_TICKS = 5;
const KILL_SEARCH = 32;

export class PveController {
  readonly mobs: MobTracker;
  readonly combat: CombatController;
  readonly follower: FollowController;
  readonly hotbar: Hotbar;
  guard: GuardSettings;
  fleeHealth: number;
  private readonly collectRadius: number;
  private readonly d: PveDeps;
  private readonly log: Logger;
  private fg: Foreground = { kind: 'idle' };
  private episode: Episode | undefined;
  /** Bumped whenever the foreground's running goto/fight must not report back (suspended, replaced). */
  private fgToken = 0;
  private epToken = 0;
  private resumePending = false;
  private returnHome = false;
  private fleeCooldownUntil = 0;
  private readonly ignore = new Map<bigint, number>();
  private n = 0;
  private readonly unsubs: (() => void)[] = [];
  readonly stats = { fights: 0, kills: 0, flees: 0, guardTriggers: 0 };

  constructor(deps: PveDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    const o = deps.options ?? {};
    this.guard = { on: o.guard?.on ?? false, radius: o.guard?.radius ?? DEFAULT_GUARD_RADIUS };
    this.fleeHealth = o.fleeHealth ?? 8;
    this.collectRadius = o.collectRadius ?? 8;
    this.log.info(`pve: guard ${this.guard.on ? `on, radius ${this.guard.radius}` : 'off'}, flee below health ${this.fleeHealth}`);
    const { world, loop, skills, source } = deps;
    this.mobs = new MobTracker(source, {
      entities: () => world.entities,
      selfRuntimeId: () => world.self.runtimeId,
      selfPos: () => (loop.state.ready ? loop.state.pos : undefined),
    });
    this.hotbar = new Hotbar(source, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
    this.combat = new CombatController({
      loop,
      mover: skills,
      entities: () => world.entities,
      mobs: this.mobs,
      inventory: world.inventory,
      hotbar: this.hotbar,
      source,
      selfRuntimeId: () => world.self.runtimeId,
      logger: this.log,
    });
    this.follower = new FollowController({ loop, mover: skills, entities: () => world.entities, logger: this.log });
    this.unsubs.push(
      loop.onBeforeStep(() => {
        if (++this.n % STEP_TICKS === 0) this.step();
      }),
      this.mobs.onHit((g, damage) => {
        this.log.info(`pve: took ${damage.toFixed(1)} damage${g ? ` (probably ${bareType(g.type)} #${g.runtimeId}, ${g.why})` : ''}, health ${this.health()}`);
      }),
    );
  }

  dispose(): void {
    this.stop();
    for (const u of this.unsubs.splice(0)) u();
    this.combat.dispose();
    this.follower.dispose();
    this.mobs.dispose();
    this.hotbar.dispose();
  }

  // ---- state -----------------------------------------------------------------------------------

  /** A behaviour here moves the bot (night safety pauses meanwhile; AFK nudges skip). */
  ownsMovement(): boolean {
    return this.episode !== undefined || this.fg.kind !== 'idle';
  }

  /** One line for !status: idle / guarding r=16 / following Steve / fighting zombie / fleeing / ... */
  behaviour(): string {
    const ep = this.episode;
    if (ep?.kind === 'flee') return 'fleeing';
    if (ep?.kind === 'guard') return ep.phase === 'collect' ? 'collecting drops' : `fighting ${bareType(ep.type)}${ep.inPlace ? ' (in place)' : ''}`;
    const fg = this.fg;
    switch (fg.kind) {
      case 'follow':
        return `following ${fg.label}`;
      case 'come':
        return `coming to ${fg.name}`;
      case 'walk':
        return fg.label;
      case 'kill': {
        const t = this.combat.target;
        return `${t ? `fighting ${bareType(t.type)}` : 'looking for'} (kill ${fg.type} ${fg.killed}/${fg.want})`;
      }
      case 'idle':
        return this.guard.on ? `guarding r=${this.guard.radius}` : 'idle';
    }
  }

  status(): Record<string, unknown> {
    return {
      behaviour: this.behaviour(),
      guard: { ...this.guard },
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

  // ---- commands --------------------------------------------------------------------------------

  setGuard(g: Partial<GuardSettings>): GuardSettings {
    this.guard = { on: g.on ?? this.guard.on, radius: g.radius ?? this.guard.radius };
    this.log.info(`guard ${this.guard.on ? `on, radius ${this.guard.radius}` : 'off'}`);
    return { ...this.guard };
  }

  /** Cancel everything (follow, come, walk, kill, a fight, a flight) and go idle. Returns what was running. */
  stop(): string {
    const was = this.behaviour();
    this.endEpisode();
    this.resumePending = false;
    this.returnHome = false;
    this.replaceForeground({ kind: 'idle' });
    if (this.d.skills.nav.busy) this.d.skills.cancel();
    return was;
  }

  /** On death: drop the episode and the foreground (guard settings stay). */
  onDeath(): void {
    this.stop();
  }

  /** Follow a player (by name) or an entity (by runtime id) until stopped. Refuses nothing but itself. */
  follow(target: FollowTarget): string {
    const label = 'playerName' in target ? target.playerName : `${bareType(this.d.world.entities.get(target.runtimeId)?.type ?? 'entity')} #${target.runtimeId}`;
    this.replaceForeground({ kind: 'follow', target, label });
    if (!this.episode) void this.follower.follow(target);
    return label;
  }

  /** Walk to within 2 blocks of the player's current position. */
  come(name: string): Promise<SkillResult> {
    return new Promise((resolve) => {
      this.replaceForeground({ kind: 'come', name, done: resolve });
      if (!this.episode) this.runForeground();
    });
  }

  /** goto that survives guard interruptions (resumed afterwards). */
  walk(goal: Goal, opts: GotoOptions = {}, label?: string): Promise<SkillResult> {
    return new Promise((resolve) => {
      this.replaceForeground({ kind: 'walk', goal, opts, label: label ?? `walking to ${goalText(goal)}`, done: resolve });
      if (!this.episode) this.runForeground();
    });
  }

  /** Kill up to `n` mobs of `type` within 32 blocks, nearest first. Refuses players. */
  kill(type: string, n: number): Promise<KillResult> {
    if (refusedKillType(type, this.d.world.entities)) {
      return Promise.resolve({ ok: false, type, killed: 0, want: n, reason: 'refused_player', fights: [] });
    }
    return new Promise((resolve) => {
      this.replaceForeground({ kind: 'kill', type, want: n, killed: 0, done: resolve });
      if (this.episode?.kind === 'flee') return; // resumed after the flight
      this.endEpisode(); // an explicit kill replaces a guard fight
      this.runForeground();
    });
  }

  // ---- foreground ------------------------------------------------------------------------------

  private replaceForeground(next: Foreground): void {
    const old = this.fg;
    this.fgToken++;
    this.fg = next;
    if (old.kind === 'follow') this.follower.stop();
    if (old.kind === 'kill') {
      if (this.combat.busy && !this.episode) this.combat.cancel();
      old.done({ ok: false, type: old.type, killed: old.killed, want: old.want, reason: 'interrupted', fights: [] });
    }
    if (old.kind === 'come' || old.kind === 'walk') {
      if (this.d.skills.nav.busy && !this.episode) this.d.skills.cancel();
      old.done({ ok: false, reason: 'interrupted' });
    }
  }

  /** Start (or resume) the foreground behaviour. */
  private runForeground(): void {
    const fg = this.fg;
    const token = ++this.fgToken;
    switch (fg.kind) {
      case 'idle':
        return;
      case 'follow':
        void this.follower.follow(fg.target);
        return;
      case 'come':
        void this.follower.come(fg.name).then((r) => {
          if (token !== this.fgToken) return;
          this.fg = { kind: 'idle' };
          fg.done(r);
        });
        return;
      case 'walk':
        void this.d.skills.goto(fg.goal, fg.opts).then((r) => {
          if (token !== this.fgToken) return;
          this.fg = { kind: 'idle' };
          fg.done(r);
        });
        return;
      case 'kill':
        void this.runKill(fg, token);
        return;
    }
  }

  private suspendForeground(): void {
    this.fgToken++;
    const fg = this.fg;
    if (fg.kind === 'follow') this.follower.stop();
    if (fg.kind === 'kill' && this.combat.busy) this.combat.cancel();
    if ((fg.kind === 'come' || fg.kind === 'walk') && this.d.skills.nav.busy) this.d.skills.cancel();
  }

  private async runKill(job: Extract<Foreground, { kind: 'kill' }>, token: number): Promise<void> {
    const fights: FightResult[] = [];
    let reason: KillResult['reason'] = 'done';
    while (job.killed < job.want) {
      if (token !== this.fgToken) return;
      const target = this.nearestOfType(job.type);
      if (!target) {
        reason = 'none_left';
        break;
      }
      const r = await this.combat.fight(target.runtimeId);
      if (token !== this.fgToken) return;
      fights.push(r);
      this.countFight(r);
      if (r.ok) {
        job.killed++;
        await this.d.skills.collect(this.collectRadius, 200);
        if (token !== this.fgToken) return;
      } else if (r.reason === 'interrupted') {
        return;
      } else {
        this.ignore.set(target.runtimeId, performance.now() + 30_000);
      }
    }
    this.fg = { kind: 'idle' };
    job.done({ ok: job.killed >= job.want, type: job.type, killed: job.killed, want: job.want, reason, fights });
  }

  private nearestOfType(type: string): EntityInfo | undefined {
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

  // ---- episodes --------------------------------------------------------------------------------

  private endEpisode(): void {
    if (!this.episode) return;
    this.epToken++;
    this.episode = undefined;
    if (this.combat.busy) this.combat.cancel();
    if (this.d.skills.nav.busy) this.d.skills.cancel();
  }

  private step(): void {
    if (this.d.inactive() || !this.d.loop.state.ready) return;
    const me = this.d.loop.state.pos;
    const now = performance.now();
    const health = this.health();
    const low = health > 0 && health < this.fleeHealth;

    // flee (not while night safety is already walking to the shelter: same place, and interrupting
    // its goto would count as a failed retreat)
    if (low && this.episode?.kind !== 'flee' && now >= this.fleeCooldownUntil && this.d.night?.state !== 'going') {
      const threat = this.nearestHostile(me, 16);
      if (threat) {
        const plan = this.fleeTarget(me, threat);
        if (plan) {
          this.startFlee(plan.to, threat, plan.kind);
          return;
        }
      }
    }
    if (this.episode) return;

    // guard (only defends in place while the health is low)
    if (this.guard.on && this.fg.kind !== 'kill') {
      const pick = this.pickThreat(me, low);
      if (pick) {
        this.startGuardFight(pick.e, pick.inPlace);
        return;
      }
    }
    if (this.resumePending) {
      this.resumePending = false;
      const goHome = this.returnHome;
      this.returnHome = false;
      if (this.fg.kind !== 'idle') {
        this.runForeground();
      } else if (goHome) {
        const home = this.d.home();
        if (home && dist(me, { x: home.x + 0.5, y: home.y, z: home.z + 0.5 }) > 1.5 && !this.d.night?.wantsShelter()) {
          this.log.info(`guard: returning home to ${home.x} ${home.y} ${home.z}`);
          void this.walk({ type: 'block', p: home }, { timeoutTicks: 2400 }, 'returning home');
        }
      }
    }
  }

  private nearestHostile(me: Vec3, r: number): EntityInfo | undefined {
    let best: EntityInfo | undefined;
    let bd = Infinity;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e)) continue;
      const d = dist(entityFeet(e), me);
      if (d <= r && d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  /** Hostiles, plus neutral mobs that hit or target the bot. Never players, items or passive mobs. */
  private isThreat(e: EntityInfo): boolean {
    if (isPlayerEntity(e)) return false;
    const st = this.mobs.get(e.runtimeId);
    if (st?.dead) return false;
    const cls = classify(e.type);
    if (cls === 'hostile') return true;
    if (cls !== 'neutral' && cls !== 'other') return false;
    const hit = this.mobs.lastHitBy;
    return this.mobs.targetsUs(e.runtimeId) || (hit?.runtimeId === e.runtimeId && performance.now() - hit.at < 10_000);
  }

  private pickThreat(me: Vec3, low: boolean): { e: EntityInfo; inPlace: boolean } | undefined {
    const night = this.d.night;
    let inPlace = low;
    if (night?.wantsShelter()) {
      if (night.inside()) inPlace = true;
      else if (night.state === 'going') return undefined;
    }
    const home = this.d.home();
    const center = this.fg.kind === 'idle' && home && !inPlace ? { x: home.x + 0.5, y: home.y, z: home.z + 0.5 } : me;
    const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
    const now = performance.now();
    const hit = this.mobs.lastHitBy;
    let best: { e: EntityInfo; score: number } | undefined;
    for (const e of this.d.world.entities.values()) {
      if (!this.isThreat(e)) continue;
      if ((this.ignore.get(e.runtimeId) ?? 0) > now) continue;
      const f = entityFeet(e);
      if (inPlace) {
        if (reachDistance(eye, e) > 3.2) continue;
      } else {
        if (dist(f, center) > this.guard.radius || dist(f, me) > this.guard.radius + CHASE_EXTRA) continue;
        if (Math.abs(f.y - me.y) > 6) continue;
      }
      let score = dist(f, me);
      if (hit?.runtimeId === e.runtimeId && now - hit.at < 10_000) score -= 100;
      else if (this.mobs.targetsUs(e.runtimeId)) score -= 50;
      if (!best || score < best.score) best = { e, score };
    }
    return best ? { e: best.e, inPlace } : undefined;
  }

  private startGuardFight(e: EntityInfo, inPlace: boolean): void {
    this.suspendForeground();
    const ep: Episode = { kind: 'guard', type: e.type, phase: 'fight', inPlace };
    this.episode = ep;
    const token = ++this.epToken;
    this.stats.guardTriggers++;
    this.d.metrics?.inc('pve.guard');
    this.log.info(`guard: ${bareType(e.type)} #${e.runtimeId} ${inPlace ? 'within reach (defending in place)' : `within ${this.guard.radius} blocks`}, fighting`);
    const opts: FightOptions = inPlace ? { approach: false, maxRange: 5, outOfRangeTicks: 20, timeoutTicks: 600 } : { maxRange: this.guard.radius + CHASE_EXTRA };
    void this.combat.fight(e.runtimeId, opts).then(async (r) => {
      if (token !== this.epToken) return;
      this.countFight(r);
      if (!r.ok) this.ignore.set(e.runtimeId, performance.now() + (r.reason === 'out_of_range' ? 10_000 : 30_000));
      if (r.ok && !inPlace) {
        ep.phase = 'collect';
        await this.d.skills.collect(this.collectRadius, 200);
        if (token !== this.epToken) return;
      }
      this.episode = undefined;
      this.resumePending = true;
      this.returnHome = !inPlace;
    });
  }

  private fleeTarget(me: Vec3, threat: EntityInfo): { to: Vec3; kind: string } | undefined {
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

  private startFlee(to: Vec3, threat: EntityInfo, kind: string): void {
    this.endEpisode();
    this.suspendForeground();
    // a kill job does not survive a flight
    if (this.fg.kind === 'kill') this.replaceForeground({ kind: 'idle' });
    const ep: Episode = { kind: 'flee', to, from: threat.type };
    this.episode = ep;
    const token = ++this.epToken;
    this.stats.flees++;
    this.d.metrics?.inc('pve.flees');
    this.log.warn(`flee: health ${this.health()} < ${this.fleeHealth} with ${bareType(threat.type)} near; running to ${kind} ${to.x} ${to.y} ${to.z}`);
    const goal: Goal = kind === 'away' ? { type: 'near', p: { x: to.x + 0.5, y: to.y, z: to.z + 0.5 }, r: 2 } : { type: 'block', p: to };
    void this.d.skills.goto(goal, { timeoutTicks: 1200, sprint: true }).then((r) => {
      if (token !== this.epToken) return;
      this.log.info(`flee: ${r.ok ? 'arrived' : r.reason}`);
      this.episode = undefined;
      this.fleeCooldownUntil = performance.now() + 10_000;
      this.resumePending = true;
      this.returnHome = false;
    });
  }

  private countFight(r: FightResult): void {
    this.stats.fights++;
    this.d.metrics?.inc('pve.fights');
    this.d.metrics?.inc(`pve.fight.${r.reason}`);
    if (r.ok) {
      this.stats.kills++;
      this.d.metrics?.inc('pve.kills');
    }
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

function goalText(g: Goal): string {
  switch (g.type) {
    case 'block':
      return `${g.p.x} ${g.p.y} ${g.p.z}`;
    case 'near':
      return `${g.p.x.toFixed(1)} ${g.p.y.toFixed(1)} ${g.p.z.toFixed(1)}`;
    case 'xz':
      return `${g.x} ${g.z}`;
  }
}
