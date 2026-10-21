// Night safety (PLAN.md task 5.2): track the world time, walk to a marked shelter at dusk, leave at
// dawn. Reusable by any task that has a mover (BotSkills.goto).
//
// World time on BDS 1.26.60 (measured on bds-hard, docs/runbook.md): there is no `set_time` any more.
// The server sends `sync_world_clocks`: `initialize_registry` at login (clock "minecraft:overworld"
// with its time and markers sunset 12000, night 13000, midnight 18000, sunrise 23000, day 1000, noon
// 6000), then `sync_state` {clock_id, time, paused} every 256 ticks (12.8 s) and right after
// `/time set`. `start_game.day_cycle_stop_time` carries the time at login and the `doDayLightCycle`
// game rule (start_game.gamerules, game_rules_changed) says whether it advances. Older versions send
// `set_time`; both are handled. Between syncs the clock advances one unit per 50 ms.
import type { AnyPacket, Vec3 } from '../connection/types.ts';
import type { Metrics } from '../connection/metrics.ts';
import { silentLogger, type Logger } from '../log.ts';
import type { SkillResult } from '../skills/types.ts';
import type { Goal } from '../skills/nav/goals.ts';

export const DAY_TICKS = 24000;
/** Retreat window start (time of day): sunset. Hostile mobs spawn from about 13000. */
export const DUSK = 12000;
/** Leave the shelter from here (sunrise); mobs burn soon after. */
export const DAWN = 23000;

export function timeOfDay(t: number): number {
  return ((Math.floor(t) % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
}

/** True in the shelter window [DUSK, DAWN) of the time of day. */
export function isNight(t: number, dusk = DUSK, dawn = DAWN): boolean {
  const tod = timeOfDay(t);
  return dusk <= dawn ? tod >= dusk && tod < dawn : tod >= dusk || tod < dawn;
}

/** The part of `Connection` the clock uses. */
export interface ClockConnection {
  on(name: string, fn: (p: AnyPacket) => void): () => void;
  onClose(fn: () => void): () => void;
}

interface GameRule {
  name: string;
  value: unknown;
}
interface ClockState {
  clock_id: bigint | number | string;
  time: number;
  paused: boolean;
}
interface ClockData {
  id: bigint | number | string;
  name: string;
  time: number;
  paused: boolean;
}

export class WorldClock {
  /** Server time at the last sync (ticks). */
  private base: number | undefined;
  private baseAt = 0;
  private paused = false;
  private cycle = true;
  private overworldId: string | undefined;
  private readonly now: () => number;
  private readonly unsubs: (() => void)[] = [];
  private readonly conn: ClockConnection;
  /** Number of time syncs received (any source). */
  syncs = 0;
  lastSource: 'sync_world_clocks' | 'set_time' | 'start_game' | undefined;

  constructor(conn: ClockConnection, opts: { now?: () => number } = {}) {
    this.conn = conn;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.unsubs.length) return;
    const c = this.conn;
    this.unsubs.push(
      c.on('start_game', (raw) => {
        const p = raw as unknown as { day_cycle_stop_time?: number; gamerules?: GameRule[] };
        this.overworldId = undefined;
        this.applyRules(p.gamerules);
        if (typeof p.day_cycle_stop_time === 'number') this.set(p.day_cycle_stop_time, 'start_game');
      }),
      c.on('game_rules_changed', (raw) => {
        const p = raw as unknown as { rules?: GameRule[] };
        this.applyRules(p.rules);
      }),
      c.on('set_time', (raw) => {
        const p = raw as unknown as { time: number };
        this.set(p.time, 'set_time');
      }),
      c.on('sync_world_clocks', (raw) => {
        const p = raw as unknown as { payload_type: string; sync_states?: ClockState[]; clocks?: ClockData[] };
        if (p.payload_type === 'initialize_registry' && p.clocks) {
          const ow = p.clocks.find((k) => k.name === 'minecraft:overworld') ?? p.clocks[0];
          if (ow) {
            this.overworldId = String(ow.id);
            this.paused = ow.paused;
            this.set(ow.time, 'sync_world_clocks');
          }
        } else if (p.payload_type === 'sync_state' && p.sync_states) {
          // Before the registry arrives, take the first clock (the overworld is the only one on BDS).
          const s = p.sync_states.find((k) => this.overworldId === undefined || String(k.clock_id) === this.overworldId);
          if (s) {
            this.paused = s.paused;
            this.set(s.time, 'sync_world_clocks');
          }
        }
      }),
      c.onClose(() => {
        this.base = undefined;
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubs.splice(0)) u();
  }

  /** True once a time is known for the current session. */
  get known(): boolean {
    return this.base !== undefined;
  }

  get running(): boolean {
    return this.cycle && !this.paused;
  }

  /** Current world time (ticks), extrapolated since the last sync; undefined before the first one. */
  get time(): number | undefined {
    if (this.base === undefined) return undefined;
    return this.base + (this.running ? Math.floor((this.now() - this.baseAt) / 50) : 0);
  }

  get timeOfDay(): number | undefined {
    const t = this.time;
    return t === undefined ? undefined : timeOfDay(t);
  }

  status(): Record<string, unknown> {
    return { time: this.time ?? null, timeOfDay: this.timeOfDay ?? null, running: this.running, syncs: this.syncs, source: this.lastSource ?? null };
  }

  private set(time: number, source: WorldClock['lastSource']): void {
    // Re-anchor the extrapolation only when the cycle runs; when paused the time is fixed anyway.
    this.base = time;
    this.baseAt = this.now();
    this.syncs++;
    this.lastSource = source;
  }

  private applyRules(rules: GameRule[] | undefined): void {
    const r = rules?.find((x) => x.name.toLowerCase() === 'dodaylightcycle');
    if (!r || typeof r.value !== 'boolean') return;
    if (r.value === this.cycle) return;
    // Freeze or resume at the current extrapolated time.
    const t = this.time;
    this.cycle = r.value;
    if (t !== undefined) {
      this.base = t;
      this.baseAt = this.now();
    }
  }
}

/** Where the bot can be sent (BotSkills satisfies it). */
export interface Mover {
  goto(goal: Goal, opts?: { timeoutTicks?: number }): Promise<SkillResult>;
  cancel(): void;
}

export type NightState = 'off' | 'day' | 'going' | 'sheltered' | 'unreachable' | 'gave_up' | 'returning';

export interface NightSafetyOptions {
  clock: Pick<WorldClock, 'time' | 'known'>;
  mover: Mover;
  /** Feet position (undefined = unknown, e.g. not spawned). */
  position: () => Vec3 | undefined;
  /** The bot is dead or not spawned: do nothing. */
  inactive?: () => boolean;
  shelter?: Vec3 | undefined;
  /** Where to go at dawn (optional). */
  home?: () => Vec3 | undefined;
  log?: Logger;
  metrics?: Metrics;
  /** Horizontal distance from the centre of the shelter block that counts as inside. Default 1.0. */
  tolerance?: number;
  /** Wait between attempts after a failed retreat. Default 60 s. */
  retryMs?: number;
  /** Failed retreats per night before giving up until the next dusk. Default 3. */
  maxAttempts?: number;
  /** goto timeout (ticks). Default 1200 (60 s). */
  gotoTimeoutTicks?: number;
  dusk?: number;
  dawn?: number;
  now?: () => number;
}

export type NightEvent =
  | { kind: 'retreat'; to: Vec3 }
  | { kind: 'sheltered'; at: Vec3; ms: number }
  | { kind: 'unreachable'; reason: string; attempt: number; gaveUp: boolean }
  | { kind: 'dawn'; home: Vec3 | undefined };

/**
 * State machine, evaluated by `check()` (call it every second or every tick):
 * - day: nothing (at the dawn transition, cancel a running retreat and walk home if one is set);
 * - night and more than `tolerance` from the shelter: goto shelter; on failure log, stay put, retry
 *   after `retryMs`, at most `maxAttempts` times per night, then give up until the next dusk;
 * - night and inside: `sheltered` (re-entered automatically if pushed out, e.g. after a respawn).
 */
export class NightSafety {
  shelter: Vec3 | undefined;
  state: NightState = 'day';
  attempts = 0;
  retreats = 0;
  lastResult: SkillResult | undefined;
  private readonly o: Required<Omit<NightSafetyOptions, 'shelter' | 'home' | 'metrics' | 'inactive'>> & Pick<NightSafetyOptions, 'home' | 'metrics' | 'inactive'>;
  private nextAttemptAt = 0;
  private wasNight: boolean | undefined;
  private going: Promise<void> | undefined;
  private goingSince = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(e: NightEvent) => void>();

  constructor(opts: NightSafetyOptions) {
    this.shelter = opts.shelter;
    this.o = {
      clock: opts.clock,
      mover: opts.mover,
      position: opts.position,
      inactive: opts.inactive,
      home: opts.home,
      log: opts.log ?? silentLogger,
      metrics: opts.metrics,
      tolerance: opts.tolerance ?? 1.0,
      retryMs: opts.retryMs ?? 60_000,
      maxAttempts: opts.maxAttempts ?? 3,
      gotoTimeoutTicks: opts.gotoTimeoutTicks ?? 1200,
      dusk: opts.dusk ?? DUSK,
      dawn: opts.dawn ?? DAWN,
      now: opts.now ?? (() => Date.now()),
    };
  }

  onEvent(fn: (e: NightEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Evaluate every `intervalMs` (default 1 s). */
  start(intervalMs = 1000): void {
    this.stop();
    this.timer = setInterval(() => {
      this.check();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  setShelter(p: Vec3 | undefined): void {
    this.shelter = p ? { ...p } : undefined;
    this.attempts = 0;
    this.nextAttemptAt = 0;
    if (this.state === 'gave_up' || this.state === 'unreachable') this.state = 'day';
    this.o.log.info(p ? `shelter set to ${fmt(p)}` : 'shelter cleared');
  }

  /** True while the bot should be in the shelter (night and a shelter is set). */
  wantsShelter(): boolean {
    const t = this.o.clock.time;
    return this.shelter !== undefined && t !== undefined && isNight(t, this.o.dusk, this.o.dawn);
  }

  inside(pos = this.o.position()): boolean {
    const s = this.shelter;
    if (!s || !pos) return false;
    // shelter = a feet block; compare with the centre of that block
    return Math.hypot(pos.x - (Math.floor(s.x) + 0.5), pos.z - (Math.floor(s.z) + 0.5)) <= this.o.tolerance && Math.abs(pos.y - Math.floor(s.y)) < 1.5;
  }

  status(): Record<string, unknown> {
    const t = this.o.clock.time;
    return {
      state: this.shelter ? this.state : 'off',
      shelter: this.shelter ?? null,
      night: t === undefined ? null : isNight(t, this.o.dusk, this.o.dawn),
      timeOfDay: t === undefined ? null : timeOfDay(t),
      attempts: this.attempts,
      retreats: this.retreats,
      lastResult: this.lastResult ?? null,
    };
  }

  check(): void {
    const t = this.o.clock.time;
    if (!this.shelter || t === undefined || this.o.inactive?.()) return;
    const night = isNight(t, this.o.dusk, this.o.dawn);
    const now = this.o.now();
    if (night && this.wasNight === false) {
      // dusk: a fresh budget for this night
      this.attempts = 0;
      this.nextAttemptAt = 0;
    }
    if (!night) {
      if (this.wasNight === true) this.onDawn();
      this.wasNight = false;
      if (this.state !== 'returning') this.state = 'day';
      return;
    }
    this.wasNight = true;
    if (this.going) return;
    const pos = this.o.position();
    if (this.inside(pos)) {
      this.state = 'sheltered';
      return;
    }
    if (this.attempts >= this.o.maxAttempts) {
      this.state = 'gave_up';
      return;
    }
    if (now < this.nextAttemptAt) return;
    this.retreat(now);
  }

  private retreat(now: number): void {
    const to = this.shelter;
    if (!to) return;
    this.state = 'going';
    this.goingSince = now;
    this.o.log.info(`night: retreating to the shelter at ${fmt(to)} (time of day ${this.o.clock.time === undefined ? '?' : timeOfDay(this.o.clock.time)})`);
    this.o.metrics?.inc('night.retreats');
    this.emit({ kind: 'retreat', to });
    this.going = this.o.mover
      .goto({ type: 'block', p: to }, { timeoutTicks: this.o.gotoTimeoutTicks })
      .then(
        (r) => r,
        (e: unknown): SkillResult => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }),
      )
      .then((r) => {
        this.going = undefined;
        this.lastResult = r;
        if (this.state !== 'going') return; // dawn or a new shelter in the meantime
        if (r.ok && this.inside()) {
          this.state = 'sheltered';
          this.attempts = 0;
          this.retreats++;
          const ms = this.o.now() - this.goingSince;
          const at = this.o.position() ?? to;
          this.o.log.info(`night: inside the shelter after ${(ms / 1000).toFixed(1)} s`);
          this.emit({ kind: 'sheltered', at, ms });
          return;
        }
        this.attempts++;
        const reason = r.ok ? 'arrived outside the tolerance' : r.reason;
        const gaveUp = this.attempts >= this.o.maxAttempts;
        this.nextAttemptAt = this.o.now() + this.o.retryMs;
        this.state = gaveUp ? 'gave_up' : 'unreachable';
        this.o.metrics?.inc('night.unreachable');
        this.o.log.warn(
          gaveUp
            ? `night: shelter unreachable (${reason}), attempt ${this.attempts}/${this.o.maxAttempts}; giving up until the next dusk, staying put`
            : `night: shelter unreachable (${reason}), attempt ${this.attempts}/${this.o.maxAttempts}; staying put, retry in ${Math.round(this.o.retryMs / 1000)} s`,
        );
        this.emit({ kind: 'unreachable', reason, attempt: this.attempts, gaveUp });
      });
  }

  private onDawn(): void {
    if (this.going) this.o.mover.cancel();
    this.attempts = 0;
    const home = this.o.home?.();
    this.o.log.info(`dawn: leaving the shelter${home ? `, back to ${fmt(home)}` : ''}`);
    this.emit({ kind: 'dawn', home });
    if (!home) return;
    this.state = 'returning';
    void this.o.mover.goto({ type: 'block', p: home }, { timeoutTicks: this.o.gotoTimeoutTicks * 5 }).then((r) => {
      if (this.state === 'returning') this.state = 'day';
      if (!r.ok) this.o.log.warn(`dawn: could not walk home (${r.reason})`);
    });
  }

  private emit(e: NightEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }
}

function fmt(v: Vec3): string {
  return `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.z.toFixed(1)}`;
}
