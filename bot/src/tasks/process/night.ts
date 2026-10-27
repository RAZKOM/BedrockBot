// Night shelter as a process (PLAN.md 7.8, Track Q; docs/processes.md). NightSafety (tasks/night.ts)
// keeps its clock and state machine and its 1 s timer (dusk / dawn transitions, attempt budget); this
// process only decides when it may move: it wants control from dusk to dawn while a shelter is set and
// the bot walks there, a retreat is due, or the bot is inside (it then holds the bot there: user
// commands wait until dawn). While unreachable or given up it does not want control, so guard and the
// owner's commands run. Pre-empted (a flight, a fight in place) = the retreat is cancelled without
// counting as a failed attempt and planned again when control comes back.
//
// Sleeping (wave 7, Track W; docs/survival.md "Sleep"): with a bed attached (`attachBed`), the
// process prefers the bed to standing in the shelter. In the sleep window (time of day 12542 to
// 23459) and with a bed known (within 8 blocks of the shelter or home, or at the `bed` waypoint) it
// wants control, walks next to the bed, clicks it and stays asleep until the server wakes the bot (the
// morning, or the whole server asleep: the night is skipped). Refused because of monsters: it defends
// in place (fights what comes within reach) and tries again every 20 s; refused because it is not
// night yet: again in 20 s; any other failure counts, and after 3 the beds are given up for the night
// (the shelter rule takes over). `!sleep` asks for it once tonight even with auto-sleep off.
// A user command marked urgent (`!come now`) makes the process yield (`yieldWhile`).
import type { NightSafety } from '../night.ts';
import { BaseProcess, PRIORITY, type ProcessStatus } from './manager.ts';
import { etaFor, navRemaining, type ProcessMover } from './goto.ts';
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { SkillResult } from '../../skills/types.ts';
import { findBeds, inSleepWindow, type BedWorld, type SleepController, type SleepResult } from '../../skills/survival/sleep.ts';

/** Retry delay after a refusal (monsters near, not night yet) or a failed walk. */
export const BED_RETRY_MS = 20_000;
/** Failures per night before the beds are given up until the next night. */
export const BED_MAX_FAILS = 3;
/** Beds are searched within this radius of the shelter / home (and 2 of the bed waypoint). */
export const BED_SEARCH_RADIUS = 8;
/** Walk to within this distance of the bed (the server refuses beyond about 3). */
export const BED_STAND_RADIUS = 1.8;

/** What the night process needs for sleeping (wired by chat/commands-pve.ts). */
export interface NightBed {
  sleeper: SleepController;
  world: BedWorld;
  mover: ProcessMover;
  position(): Vec3 | undefined;
  /** Search centres: the shelter and home (radius 8). */
  centres(): Vec3[];
  /** The `bed` waypoint, if set (searched within 2). */
  waypoint(): Vec3 | undefined;
  /** Fight one hostile within reach without walking; resolves false when there was none. */
  defend?(): Promise<boolean>;
  stopDefend?(): void;
  log?: Logger;
}

export type BedPhase = 'idle' | 'walking' | 'clicking' | 'asleep' | 'waiting' | 'defending';

export type NightBedEvent =
  | { kind: 'asleep'; bed: Vec3 }
  | { kind: 'refused'; reason: string; bed: Vec3 }
  | { kind: 'awake'; morning: boolean; ms: number }
  | { kind: 'gave_up'; reason: string };

export class NightProcess extends BaseProcess {
  readonly name = 'night';
  readonly kind = 'auto' as const;
  private readonly night: NightSafety;
  private readonly mover: ProcessMover | undefined;
  private readonly position: () => Vec3 | undefined;
  // ---- sleeping (Track W) ----
  private bedDeps: NightBed | undefined;
  /** Sleep automatically at night when a bed is known. */
  autoSleep = true;
  /** `!sleep`: sleep tonight even with autoSleep off. */
  private requested = false;
  /** Yield control while this returns true (an urgent user command: `!come now`). */
  yieldWhile: (() => boolean) | undefined;
  private bedMode = false;
  phase: BedPhase = 'idle';
  private bedTarget: Vec3 | undefined;
  private retryAt = 0;
  private fails = 0;
  private gaveUp = false;
  private lastReason: string | undefined;
  private wasWindow = false;
  private bedCache: { at: number; beds: Vec3[] } | undefined;
  private offSleeper: (() => void) | undefined;
  private readonly listeners = new Set<(e: NightBedEvent) => void>();
  readonly sleepStats = { attempts: 0, slept: 0, refusals: 0, mornings: 0 };

  constructor(night: NightSafety, opts: { mover?: ProcessMover; position?: () => Vec3 | undefined } = {}) {
    super();
    this.night = night;
    this.mover = opts.mover;
    this.position = opts.position ?? (() => undefined);
  }

  get priority(): number {
    return PRIORITY.night;
  }

  /** For NightSafety's `canMove` option: not while the process holds control for the bed. */
  get hasControl(): boolean {
    return this.controlled && !this.bedMode;
  }

  /** Sleeping support (Track W). */
  attachBed(b: NightBed | undefined): void {
    this.offSleeper?.();
    this.offSleeper = undefined;
    this.bedDeps = b;
    this.bedCache = undefined;
    if (!b) return;
    // the wake-up is reported from the sleeper's own event: the process may have lost control by then
    this.offSleeper = b.sleeper.onEvent((e) => {
      if (e.kind !== 'awake') return;
      const morning = !inSleepWindow(this.timeOfDay());
      if (morning) {
        this.sleepStats.mornings++;
        this.requested = false;
      }
      this.phase = 'idle';
      this.emit({ kind: 'awake', morning, ms: e.ms });
    });
  }

  get bedAttached(): boolean {
    return this.bedDeps !== undefined;
  }

  onBedEvent(fn: (e: NightBedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Time of day from the night clock (undefined before the first sync). */
  timeOfDay(): number | undefined {
    const t = this.night.status().timeOfDay;
    return typeof t === 'number' ? t : undefined;
  }

  /** Beds to try, nearest to their search centre first (cached 5 s). */
  beds(extra?: Vec3): Vec3[] {
    const b = this.bedDeps;
    if (!b) return [];
    const now = performance.now();
    if (!extra && this.bedCache && now - this.bedCache.at < 5000) return this.bedCache.beds;
    const out: Vec3[] = [];
    const add = (list: Vec3[]) => {
      for (const p of list) if (!out.some((q) => q.x === p.x && q.y === p.y && q.z === p.z)) out.push(p);
    };
    const wp = b.waypoint();
    if (wp) add(findBeds(b.world, { x: wp.x + 0.5, y: wp.y, z: wp.z + 0.5 }, 2, 2));
    for (const c of b.centres()) add(findBeds(b.world, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, BED_SEARCH_RADIUS));
    if (extra) add(findBeds(b.world, extra, BED_SEARCH_RADIUS));
    if (!extra) this.bedCache = { at: now, beds: out };
    return out;
  }

  /**
   * `!sleep`: sleep tonight (also with auto-sleep off). Returns the bed it will use, or why not:
   * `no_bed`, `not_night` (with the time of day), `no_bed_support`.
   */
  requestSleep(): { ok: boolean; reason?: string; bed?: Vec3; timeOfDay?: number } {
    const b = this.bedDeps;
    if (!b) return { ok: false, reason: 'no_bed_support' };
    if (b.sleeper.sleeping) return { ok: true, ...(b.sleeper.bed ? { bed: b.sleeper.bed } : {}) };
    const tod = this.timeOfDay();
    if (!inSleepWindow(tod)) return { ok: false, reason: 'not_night', ...(tod !== undefined ? { timeOfDay: tod } : {}) };
    const pos = this.position();
    this.bedCache = undefined;
    const list = this.beds(pos);
    const bed = list[0];
    if (!bed) return { ok: false, reason: 'no_bed' };
    this.requested = true;
    this.gaveUp = false;
    this.fails = 0;
    this.retryAt = 0;
    this.bedTarget = bed;
    this.bedCache = { at: performance.now(), beds: list };
    return { ok: true, bed };
  }

  /** The bed rule wants control now. */
  private sleepWanted(): boolean {
    const b = this.bedDeps;
    if (!b) return false;
    if (b.sleeper.sleeping) return true;
    const win = inSleepWindow(this.timeOfDay());
    if (!win) {
      if (this.wasWindow) this.newNight();
      this.wasWindow = false;
      return false;
    }
    this.wasWindow = true;
    if (!(this.autoSleep || this.requested) || this.gaveUp) return false;
    return this.bedMode || this.beds().length > 0;
  }

  /** Reset the per-night bed state (the window ended). */
  private newNight(): void {
    this.requested = false;
    this.gaveUp = false;
    this.fails = 0;
    this.retryAt = 0;
    this.bedTarget = undefined;
    this.lastReason = undefined;
  }

  override wants(): boolean {
    if (this.yieldWhile?.()) return false;
    if (this.sleepWanted()) return true;
    return this.night.wantsControl();
  }

  protected run(t: number): void {
    if (this.sleepWanted()) {
      this.bedMode = true;
      this.night.suspend(); // a retreat to the shelter in progress stops: the bed wins
      void this.bedLoop(t);
      return;
    }
    this.bedMode = false;
    this.night.check();
  }

  tick(): void {
    if (this.bedMode) {
      if (!this.sleepWanted()) {
        // bed given up or morning: back to the shelter rule (if it still wants control)
        this.bedMode = false;
        this.phase = 'idle';
        this.token++;
        this.night.check();
      }
      return;
    }
    if (this.sleepWanted() && this.controlled) {
      this.night.suspend();
      this.bedMode = true;
      void this.bedLoop(++this.token);
      return;
    }
    this.night.check();
  }

  protected halt(): void {
    if (this.bedMode) {
      const b = this.bedDeps;
      if (b) {
        b.sleeper.cancel();
        b.stopDefend?.();
        if (b.mover.nav.busy) b.mover.cancel();
        // pre-empted while in bed (a flight, a fight in place): get up
        if (b.sleeper.sleeping) b.sleeper.wake();
      }
      this.bedMode = false;
      if (!b?.sleeper.sleeping) this.phase = 'idle';
      return;
    }
    this.night.suspend();
  }

  protected override persistent = true;

  idle(): boolean {
    // in bed or on the way: the keepalive nudge must not move the bot
    if (this.bedMode) return false;
    return !this.night.walking;
  }

  private emit(e: NightBedEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  private log(): Logger {
    return this.bedDeps?.log ?? silentLogger;
  }

  private async wait(t: number, ms: number): Promise<boolean> {
    const b = this.bedDeps;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      if (t !== this.token || !b) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return t === this.token;
  }

  private fail(reason: string): void {
    this.fails++;
    this.lastReason = reason;
    this.retryAt = performance.now() + BED_RETRY_MS;
    if (this.fails >= BED_MAX_FAILS) {
      this.gaveUp = true;
      this.phase = 'idle';
      this.log().warn(`night: giving up on beds for tonight after ${this.fails} failures (${reason})`);
      this.emit({ kind: 'gave_up', reason });
    }
  }

  /** The bed routine while the process has control in bed mode (see the file comment). */
  private async bedLoop(t: number): Promise<void> {
    const b = this.bedDeps;
    if (!b) return;
    const log = this.log();
    while (t === this.token && !this.gaveUp) {
      if (b.sleeper.sleeping) {
        this.phase = 'asleep';
        await b.sleeper.waitAwake(); // the awake event (attachBed) reports it
        if (t !== this.token) return;
        if (!inSleepWindow(this.timeOfDay())) return; // morning: wants() turns false, the process ends normally
        if (!(await this.wait(t, 2000))) return; // woken in the night (hit, the bed broken): again
        continue;
      }
      const now = performance.now();
      if (now < this.retryAt) {
        // waiting for the retry: defend in place against what comes within reach
        this.phase = this.lastReason === 'monsters' ? 'defending' : 'waiting';
        const fought = (await b.defend?.()) ?? false;
        if (t !== this.token) return;
        if (!fought && !(await this.wait(t, 500))) return;
        continue;
      }
      const bed = this.bedTarget && this.stillBed(this.bedTarget) ? this.bedTarget : this.beds()[0];
      if (!bed) {
        this.fail('no_bed');
        if (!(await this.wait(t, 500))) return;
        continue;
      }
      this.bedTarget = bed;
      const pos = b.position();
      const centre = { x: bed.x + 0.5, y: bed.y, z: bed.z + 0.5 };
      if (!pos || Math.hypot(pos.x - centre.x, pos.z - centre.z) > BED_STAND_RADIUS + 0.4 || Math.abs(pos.y - bed.y) > 1.5) {
        this.phase = 'walking';
        log.info(`night: going to bed at ${bed.x} ${bed.y} ${bed.z}`);
        let r: SkillResult;
        try {
          r = await b.mover.goto({ type: 'near', p: centre, r: BED_STAND_RADIUS }, { timeoutTicks: 1200 });
        } catch (e) {
          r = { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
        if (t !== this.token) return;
        if (!r.ok) {
          log.warn(`night: could not walk to the bed (${r.reason})`);
          this.fail(`walk ${r.reason ?? 'failed'}`);
          continue;
        }
      }
      this.phase = 'clicking';
      this.sleepStats.attempts++;
      const res: SleepResult = await b.sleeper.sleep(bed);
      if (t !== this.token) return;
      if (res.ok) {
        this.sleepStats.slept++;
        this.fails = 0;
        this.lastReason = undefined;
        this.emit({ kind: 'asleep', bed });
        continue;
      }
      this.sleepStats.refusals++;
      const reason = String(res.reason ?? 'failed');
      log.info(`night: bed refused (${reason})`);
      this.emit({ kind: 'refused', reason, bed });
      if (reason === 'monsters' || reason === 'not_night') {
        // not counted: guard in place / wait and try again in 20 s
        this.lastReason = reason;
        this.retryAt = performance.now() + BED_RETRY_MS;
      } else if (reason === 'interrupted') {
        return;
      } else {
        this.fail(reason);
        if (reason === 'too_far') this.retryAt = 0;
      }
    }
  }

  private stillBed(p: Vec3): boolean {
    const blk = this.bedDeps?.world.blockAt(p);
    return blk !== undefined && (blk.name === 'bed' || blk.name.endsWith('_bed'));
  }

  status(): ProcessStatus {
    if (this.bedMode || this.bedDeps?.sleeper.sleeping) {
      const bed = this.bedTarget;
      const at = bed ? ` ${bed.x} ${bed.y} ${bed.z}` : '';
      switch (this.phase) {
        case 'asleep':
          return { line: `night: sleeping in the bed${at}` };
        case 'walking': {
          const m = this.bedDeps?.mover;
          const left = m ? navRemaining(m.nav, this.position()) : undefined;
          return { line: `night: going to bed${at}${left !== undefined ? `, ${Math.round(left)} blocks left` : ''}`, etaS: m ? etaFor(left, m.nav.lastReport, true) : undefined };
        }
        case 'defending':
        case 'waiting': {
          const s = Math.max(0, Math.round((this.retryAt - performance.now()) / 1000));
          return { line: `night: waiting to sleep (${this.lastReason === 'monsters' ? 'monsters near' : (this.lastReason ?? 'retry')}), again in ${s} s` };
        }
        default:
          return { line: `night: bed${at}` };
      }
    }
    const s = this.night.shelter;
    const st = this.night.state;
    if (this.night.walking && s) {
      const left = this.mover ? navRemaining(this.mover.nav, this.position()) : undefined;
      return {
        line: `night: going to the shelter ${s.x} ${s.y} ${s.z}${left !== undefined ? `, ${Math.round(left)} blocks left` : ''}`,
        etaS: this.mover ? etaFor(left, this.mover.nav.lastReport, true) : undefined,
      };
    }
    return { line: `night: ${st}` };
  }

  behaviour(): string {
    if (this.bedMode || this.bedDeps?.sleeper.sleeping) {
      if (this.phase === 'asleep' || this.bedDeps?.sleeper.sleeping) return 'sleeping';
      if (this.phase === 'walking') return 'going to bed';
      if (this.phase === 'defending') return 'waiting to sleep (monsters near)';
      return 'going to sleep';
    }
    return this.night.walking ? 'going to the shelter' : this.night.state === 'sheltered' ? 'sheltered' : `night ${this.night.state}`;
  }

  /** Sleep state for `!status` / the task status. */
  sleepStatus(): Record<string, unknown> {
    return {
      attached: this.bedDeps !== undefined,
      autoSleep: this.autoSleep,
      requested: this.requested,
      phase: this.phase,
      sleeping: this.bedDeps?.sleeper.sleeping ?? false,
      bed: this.bedTarget ?? null,
      fails: this.fails,
      gaveUp: this.gaveUp,
      lastReason: this.lastReason ?? null,
      ...this.sleepStats,
    };
  }
}
