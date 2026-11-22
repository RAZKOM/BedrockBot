// Track E13 (`workArchers`; docs/early-game.md "Two archers at the work (Track E13)", docs/pve.md "Two archers at the
// work", ADR 0120): two archers or more that shoot at a job at work.
//
// Track E12's `workGuard` fights the one archer that shoots at a job at work; with two it does not act (a fight on one
// left the other shooting: the damage of no fight, nothing mined). The job then ran on under fire until the health was
// under 8, and the flee's runs ended 16 from the archers, at their range, where the next arrow started the next run:
// two skeletons 10 and 12 off a bot that mines in the open took 41 to 44 in 2 minutes, the lowest health 2 or 3, 16 to
// 23 flights, the job stopped at 4 to 10 of 24.
//
// This rule walls the body in where it stands (skills/survival/seal.ts: the 9 cells round the feet and the head and
// over it with throwaway blocks, or a hole dug down in dirt), eats, and waits until the health is full and fewer than
// two archers are within ARCHERS_RANGE for CLEAR_MS; then it opens the side away from them and lets the job go on (one
// archer left is `workGuard`'s fight, from full health). A skeleton that loses its line on the bot walks up to it: at
// the wall it is in the reflex's reach, and the reflex kills it there. A job that has waited WAIT_MS in all is stopped
// (its reply says so; the shell stays shut). Hit in the shell (an open cell, a blast), it ends at once, and the flee and
// the job have the body for SHELL_HIT_RETRY_MS.
//
// Only for a job at work (the active process: a user job that is work for `workGuard`), guard off, two or more archers
// within ARCHERS_RANGE and one of them shooting (it aims at the bot with a line on it, or hit it in the last 10 s); not
// with an archer in reach (the reflex strikes it), not with a melee mob or a creeper close (the flee's and the reflex's
// rules), not where no shell can go up.
//
// Measured and not taken (ADR 0120): walking out to 24 from them and back once the work is clear (they followed: one
// run of 5 took 33, the lowest 2, nothing mined), and going out of the shell at the nearest one at a time (the job
// sooner, 54 to 66 s against 57 to 81, but 4 to 8 a run against 0 to 4).
import { silentLogger, type Logger } from '../log.ts';
import { openSide, seal, type SealDeps } from '../skills/survival/seal.ts';
import type { Vec3 } from '../world/types.ts';
import { BaseProcess, PRIORITY, type ProcessStatus } from './process/manager.ts';

/** Archers within ARCHERS_RANGE that start the rule (one is `workGuard`'s). */
export const ARCHERS_MIN = 2;
/** The archers counted: within this of the feet (3D), seen or not (`workGuard`'s range: a skeleton shoots from 15). */
export const ARCHERS_RANGE = 16;
/** One within this (feet, level): the reflex strikes it, the rule waits. */
export const ARCHERS_REACH = 4;
/** Wait for this health before going on (a full bar). */
export const HOLD_HEALTH = 20;
/** ... and for the archers to stay away this long (ms; a skeleton forgets a target it cannot see after 3 s). */
export const CLEAR_MS = 3000;
/** A job that has waited this long in all (ms) is stopped. */
export const WAIT_MS = 60_000;
/** A new shell at most this soon after the last one opened (ms). */
export const RETRY_MS = 5000;
/** Hit in the shell (the health this far under the best it had there): the shell is open or a blast came; out of it. */
export const SHELL_HIT = 2;
/** ... and no new shell for this long (ms): the flee and the job have the body. */
export const SHELL_HIT_RETRY_MS = 30_000;
/** Builds of a surface shell before the bot settles in it as it is. */
export const COVER_TRIES = 2;
/** Archers the open side faces away from: within this of the feet. */
const OPEN_SCAN = 32;

export interface ArcherSeen {
  id: bigint;
  feet: Vec3;
  /** Feet to feet (3D). */
  d: number;
  /** Aims at the bot with a line on it, or hit it in the last 10 s. */
  shooting: boolean;
}

/** What the rule reads (the host fills it). */
export interface ArchersView {
  me: Vec3;
  /** The job at work now (the active process: a user job that is work for `workGuard`, guard off, not paused), if any. */
  job: object | undefined;
  /** The live archers within ARCHERS_RANGE (and the fight's height bound), seen or not. */
  archers: readonly ArcherSeen[];
  /** A melee mob within 6 or a creeper within 8: the flee's and the reflex's, not this rule's. */
  close: boolean;
  /** A shell can go up where the body stands (blocks for it, or ground to dig in), on the ground. */
  canCover: boolean;
}

/** The rule's trigger: a job at work, ARCHERS_MIN or more archers in range, one of them shooting, none in reach, nothing close. */
export function archersPress(v: ArchersView): boolean {
  if (!v.job || v.close || v.archers.length < ARCHERS_MIN || !v.archers.some((a) => a.shooting)) return false;
  return !v.archers.some((a) => Math.hypot(a.feet.x - v.me.x, a.feet.z - v.me.z) <= ARCHERS_REACH);
}

/** What the rule needs from the PvE controller. */
export interface ArchersHost {
  /** The setting (`workArchers`). */
  enabled(): boolean;
  /** undefined: not now (inactive, not spawned, dead). */
  view(): ArchersView | undefined;
  /** The live archers within r of p (feet, 3D), seen or not. */
  archersNear(p: Vec3, r: number): Vec3[];
  health(): number;
  food(): number;
  /** One bite (the kit's eat); undefined: no kit, nothing to eat, or a bite already on. */
  eat(): Promise<boolean> | undefined;
  sealDeps(): SealDeps | undefined;
  /** Stop this job (it is no longer at work here). */
  stopJob(job: object, why: string): void;
  /** Cancel the walk and the fight under way. */
  cancel(): void;
  /** Stand still (no input). */
  stand(): void;
  log?: Logger;
  now?: () => number;
}

interface Episode {
  phase: 'build' | 'hold' | 'open';
  job: object;
  startAt: number;
  /** When the wait began. */
  holdAt?: number;
  clearSince?: number;
  /** The best health in the shell so far. */
  top?: number;
  tries: number;
  dugIn?: boolean;
}

export class ArchersProcess extends BaseProcess {
  readonly name = 'archers';
  readonly kind = 'auto' as const;
  protected override persistent = true;
  /** The rule's counts (status, the tests' rows). */
  readonly counts = { covers: 0, cleared: 0, stopped: 0, open: 0, hit: 0 };
  private ep: Episode | undefined;
  private pick: ArchersView | undefined;
  private next = 0;
  private busy = false;
  private eating = false;
  private n = 0;
  /** Each job's waits so far (ms). */
  private waited = new WeakMap<object, number>();
  private readonly h: ArchersHost;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(h: ArchersHost) {
    super();
    this.h = h;
    this.log = h.log ?? silentLogger;
    this.now = h.now ?? (() => performance.now());
  }

  /** The flee's priority, added after it and the rise: a tie is this rule's (walled in, nothing runs out of the shell). */
  get priority(): number {
    return PRIORITY.flee;
  }

  /** The current episode's phase (status, tests). */
  get phase(): string | undefined {
    return this.ep?.phase;
  }

  override wants(): boolean {
    if (this.ep) return true;
    this.pick = undefined;
    if (!this.h.enabled() || this.now() < this.next) return false;
    const v = this.h.view();
    if (!v || !archersPress(v) || !v.canCover) return false;
    if ((this.waited.get(v.job!) ?? 0) >= WAIT_MS) return false;
    this.pick = v;
    return true;
  }

  protected run(t: number, resumed: boolean): void {
    if (!this.ep) {
      const v = this.pick;
      this.pick = undefined;
      if (!v?.job) {
        this.yieldControl();
        return;
      }
      this.ep = { phase: 'build', job: v.job, startAt: this.now(), tries: 0 };
      this.counts.covers++;
      const near = Math.min(...v.archers.map((a) => a.d));
      this.log.warn(`archers: ${v.archers.length} archers within ${ARCHERS_RANGE} shooting at the work (nearest ${near.toFixed(1)}, health ${this.h.health().toFixed(1)}): walling in`);
      this.h.cancel();
    } else if (resumed) {
      this.log.info(`archers: resuming (${this.ep.phase})`);
      this.busy = false; // a build cut by the pause: the next step starts it again
    }
    this.step(t);
  }

  tick(): void {
    if (!this.controlled) return;
    if (++this.n % 5 === 0) this.step(this.token);
  }

  private step(t: number): void {
    const ep = this.ep;
    if (!ep || t !== this.token || !this.controlled) return;
    if (ep.phase === 'build') this.build(ep, t);
    else if (ep.phase === 'open') this.open(ep, t);
    else this.hold(ep, this.now());
  }

  private build(ep: Episode, t: number): void {
    if (this.busy) return;
    const deps = this.h.sealDeps();
    if (!deps) {
      this.end('no placer');
      return;
    }
    this.h.cancel();
    this.h.stand();
    this.busy = true;
    const at = deps.position();
    const off = (): boolean => Math.hypot(deps.position().x - at.x, deps.position().z - at.z) > 1.5; // knocked off the spot
    void seal(deps, () => t !== this.token || this.ep !== ep || off()).then(
      (r) => {
        if (t !== this.token || this.ep !== ep) return;
        this.busy = false;
        ep.tries++;
        if (!r.ok && !r.dugIn && ep.tries < COVER_TRIES) {
          this.log.warn(`archers: the shell is open (${r.open} cell(s)${r.reason ? `, ${r.reason}` : ''}), building it again`);
          return;
        }
        if (!r.ok) this.counts.open++;
        ep.phase = 'hold';
        ep.holdAt = this.now();
        ep.clearSince = undefined;
        ep.dugIn = r.dugIn;
        this.log.warn(`archers: walled in (${r.placed.length} placed${r.open ? `, ${r.open} cell(s) open` : ''}${r.dugIn ? ', dug in' : ''}${r.reason ? `, ${r.reason}` : ''}), health ${this.h.health().toFixed(1)}`);
      },
      (e: unknown) => {
        if (this.ep !== ep) return;
        this.busy = false;
        this.end(`the shell failed: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  }

  private hold(ep: Episode, now: number): void {
    // a bite whenever the food is under 20 (the health comes back only with the food at 18 or more)
    if (!this.eating && this.h.food() < 20) {
      const bite = this.h.eat();
      if (bite) {
        this.eating = true;
        void bite.finally(() => {
          this.eating = false;
        });
      }
    }
    // hit in the shell: an open cell the archers shoot through, or a blast; the shell does not hold the body under fire
    const hp = this.h.health();
    ep.top = Math.max(ep.top ?? hp, hp);
    if (hp <= ep.top - SHELL_HIT) {
      this.counts.hit++;
      this.addWait(ep, now);
      this.end(`hit in the shell (health ${ep.top.toFixed(1)} -> ${hp.toFixed(1)}): out of it`, SHELL_HIT_RETRY_MS);
      return;
    }
    const me = this.h.view()?.me ?? this.h.sealDeps()?.position();
    const near = me ? this.h.archersNear(me, ARCHERS_RANGE) : [];
    if (near.length < ARCHERS_MIN && this.h.health() >= HOLD_HEALTH) ep.clearSince ??= now;
    else ep.clearSince = undefined;
    if (ep.clearSince !== undefined && now - ep.clearSince >= CLEAR_MS) {
      this.counts.cleared++;
      this.addWait(ep, now);
      ep.phase = 'open';
      this.log.info(`archers: ${near.length} archer(s) within ${ARCHERS_RANGE}, health ${this.h.health().toFixed(1)}: opening the shell`);
      return;
    }
    const waited = (this.waited.get(ep.job) ?? 0) + (now - (ep.holdAt ?? now));
    if (waited >= WAIT_MS) {
      this.counts.stopped++;
      this.addWait(ep, now);
      const job = ep.job;
      const why = `${near.length} archers still within ${ARCHERS_RANGE} after ${Math.round(waited / 1000)} s`;
      this.end(`${why}: the job is stopped (the shell stays shut)`);
      this.h.stopJob(job, why);
    }
  }

  private open(ep: Episode, t: number): void {
    if (this.busy) return;
    const deps = this.h.sealDeps();
    if (!deps) {
      this.end('opened (no placer)');
      return;
    }
    const me = deps.position();
    // a dug-in shell opens through its roof (the cell over the head); a surface shell on the side away from the archers
    const side = ep.dugIn ? [{ x: Math.floor(me.x), y: Math.floor(me.y + 1e-3) + 2, z: Math.floor(me.z) }] : openSide(me, this.h.archersNear(me, OPEN_SCAN));
    this.busy = true;
    void (async () => {
      for (const p of side) if (deps.solid(p.x, p.y, p.z) === true) await deps.dig(p).catch(() => undefined);
    })().finally(() => {
      if (t !== this.token || this.ep !== ep) return;
      this.busy = false;
      this.end('opened');
    });
  }

  private addWait(ep: Episode, now: number): void {
    if (ep.holdAt === undefined) return;
    this.waited.set(ep.job, (this.waited.get(ep.job) ?? 0) + (now - ep.holdAt));
    ep.holdAt = undefined;
  }

  private end(why: string, retryMs = RETRY_MS): void {
    const ep = this.ep;
    if (!ep) return;
    this.log.info(`archers: ${why} after ${((this.now() - ep.startAt) / 1000).toFixed(1)} s`);
    this.token++;
    this.ep = undefined;
    this.busy = false;
    this.next = this.now() + retryMs;
    this.h.cancel();
    this.yieldControl();
  }

  protected halt(): void {
    this.h.cancel();
  }

  protected override reset(): void {
    this.ep = undefined;
    this.busy = false;
  }

  status(): ProcessStatus {
    const ep = this.ep;
    if (!ep) return { line: `archers ${this.h.enabled() ? 'on' : 'off'}` };
    const what = ep.phase === 'build' ? 'walling in from archers' : ep.phase === 'open' ? 'opening the shell' : 'walled in from archers, eating and waiting';
    return { line: `archers: ${what}` };
  }
}
