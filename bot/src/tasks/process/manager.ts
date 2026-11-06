// Process manager (PLAN.md task 7.8, Track Q; docs/processes.md). One process controls the bot at a
// time: every tick the manager asks each registered process whether it wants control (`wants()`),
// gives control to the one with the highest priority, pauses (does not stop) the one it replaces and
// resumes it when the higher one is done. Modelled on Baritone's PathingControlManager.
//
//   flee 100 > guard defending in place 85 > night shelter 80 > guard fight 60 > user command 40
//   (goto, follow, come, kill, gather; newest on top) > home return 20 > idle
//
// Two kinds of processes:
// - `auto` processes are registered once and decide by themselves when they want control (flee, the
//   guard fight, night shelter) or are requested and dropped (home return).
// - `user` processes are the owner's commands. They stack: a new command pre-empts the running one
//   (a new command of the same name replaces it), which resumes when the new one ends. `!pause` holds
//   every user process (auto processes keep running), `!resume` releases them, `!stop` stops them all.
//
// Lifecycle calls, all synchronous: start() (first control, or control again after it had stopped
// wanting it), pause() (pre-empted while it still wants control), resume() (control back after a
// pause), release() (it stopped wanting control while active; default pause()), stop(reason) (removed:
// cancelled, replaced, dropped at a death or the end), tick() (every tick while active). A process
// that finishes calls `manager.finished(this)` (BaseProcess.finish does), which removes it at once.
import type { Metrics } from '../../connection/metrics.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { jobAdded, jobFinished, jobRemoved } from '../../events/jobs.ts'; // decision 0059: job events

export const PRIORITY = {
  flee: 100,
  /** Guard fighting in place (inside the night shelter, or while the health is low). */
  defend: 85,
  night: 80,
  guard: 60,
  user: 40,
  chore: 30, // Track X: automatic chores (food gathering) below user commands, above the home return
  home: 20,
} as const;

export type ProcessKind = 'user' | 'auto';
export type StopReason = 'stopped' | 'replaced' | 'death' | 'dropped' | 'dispose';

export interface ProcessStatus {
  /** One line, e.g. `walking to 10 -60 3, 24 blocks left`. */
  line: string;
  /** Estimated seconds to completion, when known. */
  etaS?: number | undefined;
}

export interface Process {
  /** Short type name: goto, follow, come, kill, gather, flee, guard, night, home. */
  readonly name: string;
  readonly kind: ProcessKind;
  /** Read every tick (may depend on state: the guard fight is 85 in place, else 60). */
  readonly priority: number;
  /** User processes: kept across a death (paused while dead, resumed after the respawn). */
  readonly survivesDeath?: boolean;
  /** True once its work is over (the manager drops it). Auto processes that persist never set it. */
  readonly done: boolean;
  /** Wants control now. Called every tick for every process; may prepare its next step. */
  wants(): boolean;
  start(): void;
  resume(): void;
  pause(): void;
  release?(): void;
  stop(reason: StopReason): void;
  tick?(): void;
  /** Has control but keeps the bot still (e.g. sheltered): the keepalive nudge may run. */
  idle?(): boolean;
  status(): ProcessStatus;
  /** Short behaviour for `!status` (`walking to 10 -60 3`); default status().line. */
  behaviour?(): string;
  /** Called by the manager when the process is added (BaseProcess keeps it for finish()). */
  attach?(m: ProcessManager): void;
}

export type EntryState = 'new' | 'active' | 'paused' | 'idle';

interface Entry {
  p: Process;
  state: EntryState;
  /** Order of addition (user processes: the newest wins among equals). */
  seq: number;
}

export interface StackEntry {
  name: string;
  kind: ProcessKind;
  priority: number;
  state: EntryState;
  /** Paused because `!pause` holds the user processes. */
  held: boolean;
  line: string;
  etaS: number | undefined;
}

export interface ProcessManagerOptions {
  /** Dead, not spawned, settling after a respawn: no process runs (the active one is paused). */
  inactive?: () => boolean;
  /** Auto processes stopped when a user process is added (the owner moved the bot on purpose). Default ['home']. */
  dropOnUser?: readonly string[];
  /** Subscribe to the per-tick hook (InputLoop.onBeforeStep); omit to call tick() yourself. */
  onTick?: (fn: () => void) => () => void;
  log?: Logger;
  metrics?: Metrics;
}

export class ProcessManager {
  private readonly entries: Entry[] = [];
  private current: Entry | undefined;
  private seq = 0;
  private held = false;
  private arbitrating = false;
  private again = false;
  private readonly inactive: () => boolean;
  private readonly dropOnUser: readonly string[];
  private readonly log: Logger;
  private readonly metrics: Metrics | undefined;
  private readonly unsub: (() => void) | undefined;
  private readonly listeners = new Set<(e: { kind: 'control'; from: string | undefined; to: string | undefined }) => void>();

  constructor(opts: ProcessManagerOptions = {}) {
    this.inactive = opts.inactive ?? (() => false);
    this.dropOnUser = opts.dropOnUser ?? ['home'];
    this.log = opts.log ?? silentLogger;
    this.metrics = opts.metrics;
    this.unsub = opts.onTick?.(() => {
      this.tick();
    });
  }

  /** The process in control, if any. */
  get active(): Process | undefined {
    const c = this.current;
    return c && !c.p.done ? c.p : undefined;
  }

  /** User processes are held by `!pause`. */
  get paused(): boolean {
    return this.held;
  }

  /** A process controls the bot and moves it (the keepalive nudge waits). */
  busy(): boolean {
    const a = this.active;
    return a !== undefined && !(a.idle?.() ?? false);
  }

  has(p: Process): boolean {
    return this.entries.some((e) => e.p === p);
  }

  /** Processes of this name (user or auto). */
  find(name: string): Process[] {
    return this.entries.filter((e) => e.p.name === name).map((e) => e.p);
  }

  userProcesses(): Process[] {
    return this.entries.filter((e) => e.p.kind === 'user').map((e) => e.p);
  }

  onControl(fn: (e: { kind: 'control'; from: string | undefined; to: string | undefined }) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Add a process and arbitrate at once (a command starts in the same tick). A user process
   * replaces the user processes of the same name (they are stopped with reason `replaced`).
   */
  add<P extends Process>(p: P): P {
    if (this.has(p)) return p;
    if (p.kind === 'user') {
      for (const e of [...this.entries]) {
        if (e.p.kind === 'user' && e.p.name === p.name) this.remove(e, 'replaced');
        else if (e.p.kind === 'auto' && this.dropOnUser.includes(e.p.name)) this.remove(e, 'dropped');
      }
    }
    p.attach?.(this);
    this.entries.push({ p, state: 'new', seq: ++this.seq });
    this.log.debug(`process: + ${p.name} (${p.kind}, priority ${p.priority})`);
    jobAdded(p); // decision 0059
    this.arbitrate();
    return p;
  }

  /** Stop and remove one process. */
  stop(p: Process, reason: StopReason = 'stopped'): boolean {
    const e = this.entries.find((x) => x.p === p);
    if (!e) return false;
    this.remove(e, reason);
    this.arbitrate();
    return true;
  }

  /**
   * The active process gives control back now (its episode was cancelled from outside, e.g. guard
   * off): it is released and arbitration runs again (it may get control again with a fresh start()).
   */
  yieldControl(p: Process): void {
    const c = this.current;
    if (c?.p !== p) return;
    this.current = undefined;
    c.state = 'idle';
    this.call(c, 'release');
    this.arbitrate();
  }

  /** A process finished its work: drop it now (no stop() call), control moves on at the next arbitration. */
  finished(p: Process): void {
    const i = this.entries.findIndex((x) => x.p === p);
    if (i < 0) return;
    const [e] = this.entries.splice(i, 1);
    if (this.current === e) this.current = undefined;
    this.log.debug(`process: - ${p.name} (done)`);
    jobFinished(p); // decision 0059
  }

  /**
   * `!stop`: stop every user process (the active one and those it pre-empted) and the processes
   * named in `alsoNames` (e.g. a pending home return). Auto processes keep running. Returns the
   * status lines of what was stopped, active first.
   */
  stopUser(alsoNames: readonly string[] = []): string[] {
    const victims = this.entries.filter((e) => e.p.kind === 'user' || alsoNames.includes(e.p.name)).sort((a, b) => this.rank(b) - this.rank(a));
    const lines = victims.map((e) => e.p.status().line);
    for (const e of victims) this.remove(e, 'stopped');
    this.held = false;
    this.arbitrate();
    return lines;
  }

  /** `!pause`: hold the user processes (the active one is paused). Returns false when there is none. */
  hold(): boolean {
    this.held = true;
    this.arbitrate();
    return this.entries.some((e) => e.p.kind === 'user');
  }

  /** `!resume`. Returns false when nothing was held. */
  unhold(): boolean {
    const was = this.held;
    this.held = false;
    this.arbitrate();
    return was;
  }

  /** At a death: stop the user processes that do not survive it and the named auto processes. */
  onDeath(alsoNames: readonly string[] = []): void {
    for (const e of [...this.entries]) {
      if ((e.p.kind === 'user' && !e.p.survivesDeath) || alsoNames.includes(e.p.name)) this.remove(e, 'death');
    }
    this.pauseCurrent();
  }

  /** Active first, then paused / waiting processes by priority; idle auto processes are left out. */
  stack(): StackEntry[] {
    return [...this.entries]
      .filter((e) => !e.p.done && (e === this.current || e.state === 'paused' || e.p.kind === 'user'))
      .sort((a, b) => (a === this.current ? -1 : b === this.current ? 1 : this.rank(b) - this.rank(a)))
      .map((e) => {
        const st = e.p.status();
        return {
          name: e.p.name,
          kind: e.p.kind,
          priority: e.p.priority,
          state: e === this.current ? 'active' : e.state,
          held: this.held && e.p.kind === 'user',
          line: st.line,
          etaS: st.etaS,
        };
      });
  }

  tick(): void {
    this.arbitrate();
    const c = this.current;
    if (c && !c.p.done && c.state === 'active') c.p.tick?.();
  }

  dispose(): void {
    this.unsub?.();
    for (const e of [...this.entries]) this.remove(e, 'dispose');
    this.current = undefined;
  }

  // ---- internals ---------------------------------------------------------------------------------

  /** Sort key: priority first, newer additions win among equals. */
  private rank(e: Entry): number {
    return e.p.priority * 1e9 + e.seq;
  }

  private remove(e: Entry, reason: StopReason): void {
    const i = this.entries.indexOf(e);
    if (i < 0) return;
    this.entries.splice(i, 1);
    if (this.current === e) this.current = undefined;
    this.log.debug(`process: - ${e.p.name} (${reason})`);
    jobRemoved(e.p, reason); // decision 0059
    try {
      e.p.stop(reason);
    } catch (err) {
      this.log.warn(`process ${e.p.name}: stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private pauseCurrent(): void {
    const c = this.current;
    if (!c) return;
    this.current = undefined;
    c.state = 'paused';
    this.call(c, 'pause');
  }

  private call(e: Entry, fn: 'start' | 'resume' | 'pause' | 'release'): void {
    try {
      if (fn === 'release') (e.p.release ?? e.p.pause).call(e.p);
      else e.p[fn]();
    } catch (err) {
      this.log.warn(`process ${e.p.name}: ${fn} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Pick the process that should have control and switch to it. Re-entrant calls are folded into one more round. */
  private arbitrate(): void {
    if (this.arbitrating) {
      this.again = true;
      return;
    }
    this.arbitrating = true;
    try {
      let rounds = 0;
      do {
        this.again = false;
        this.round();
      } while (this.again && ++rounds < 5);
    } finally {
      this.arbitrating = false;
    }
  }

  private round(): void {
    for (const e of [...this.entries]) if (e.p.done) this.finished(e.p);
    if (this.inactive()) {
      this.pauseCurrent();
      return;
    }
    let best: Entry | undefined;
    let bestRank = -Infinity;
    const wanting = new Set<Entry>();
    for (const e of [...this.entries]) {
      if (e.p.kind === 'user' && this.held) continue;
      let w = false;
      try {
        w = !e.p.done && e.p.wants();
      } catch (err) {
        this.log.warn(`process ${e.p.name}: wants() failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!w) continue;
      wanting.add(e);
      const r = this.rank(e);
      if (r > bestRank) {
        bestRank = r;
        best = e;
      }
    }
    // paused auto processes that no longer want control are dropped back to idle (they reset in stop/release)
    for (const e of this.entries) {
      if (e.state === 'paused' && e !== best && !wanting.has(e) && e.p.kind === 'auto' && !(this.current === e)) e.state = 'idle';
    }
    const cur = this.current;
    if (best === cur) return;
    const from = cur?.p.name;
    if (cur) {
      this.current = undefined;
      if (this.entries.includes(cur)) {
        if (wanting.has(cur) || (cur.p.kind === 'user' && this.held)) {
          cur.state = 'paused';
          this.call(cur, 'pause');
        } else {
          cur.state = 'idle';
          this.call(cur, 'release');
        }
      }
    }
    if (best && this.entries.includes(best)) {
      const resumed = best.state === 'paused';
      best.state = 'active';
      this.current = best;
      this.call(best, resumed ? 'resume' : 'start');
      this.log.info(`process: ${best.p.name}${resumed ? ' resumed' : ' started'}${from ? ` (was ${from})` : ''}`);
      this.metrics?.inc(`process.${best.p.name}.${resumed ? 'resumed' : 'started'}`);
    } else if (from) {
      this.log.debug(`process: idle (was ${from})`);
    }
    for (const fn of [...this.listeners]) fn({ kind: 'control', from, to: this.current?.p.name });
  }
}

/**
 * Convenience base: keeps the manager, a `token` that async callbacks compare against (bumped on
 * every pause / stop, so a skill that was cancelled by a pre-emption cannot report back), and
 * `finish()`. Subclasses implement run() (start and resume), halt() (pause, release and stop) and status().
 */
export abstract class BaseProcess implements Process {
  abstract readonly name: string;
  abstract readonly kind: ProcessKind;
  abstract get priority(): number;
  readonly survivesDeath: boolean = false;
  /** Registered once and never done (flee, guard, night): stop() only cancels and resets. */
  protected persistent = false;
  done = false;
  protected manager: ProcessManager | undefined;
  protected token = 0;
  /** Has control right now. */
  protected controlled = false;

  attach(m: ProcessManager): void {
    this.manager = m;
  }

  wants(): boolean {
    return !this.done;
  }

  start(): void {
    this.controlled = true;
    this.run(++this.token, false);
  }

  resume(): void {
    this.controlled = true;
    this.run(++this.token, true);
  }

  pause(): void {
    this.token++;
    if (this.controlled) this.halt('pause');
    this.controlled = false;
  }

  release(): void {
    this.pause();
  }

  stop(reason: StopReason): void {
    this.token++;
    const had = this.controlled;
    this.controlled = false;
    if (had) this.halt('stop');
    if (this.persistent) {
      this.reset();
      return;
    }
    if (!this.done) {
      this.done = true;
      this.onStopped(reason);
    }
  }

  /** Begin (or continue after a pause) with this token; async results must check `t === this.token`. */
  protected abstract run(t: number, resumed: boolean): void;
  /** Cancel whatever runs (the skill, the follower, the fight). */
  protected abstract halt(why: 'pause' | 'stop'): void;
  /** Stopped before it finished (resolve the caller's promise). */
  protected onStopped(_reason: StopReason): void {}
  /** Persistent processes: forget the current episode (stop, a death). */
  protected reset(): void {}
  abstract status(): ProcessStatus;

  /** Give control back to the manager now (after cancelling the episode from outside). */
  protected yieldControl(): void {
    if (this.controlled) this.manager?.yieldControl(this);
  }

  /** Work is over: drop from the manager. */
  protected finish(): void {
    if (this.done) return;
    this.done = true;
    this.token++;
    this.controlled = false;
    this.manager?.finished(this);
  }
}

/** `12 s`, `3 min 5 s` */
export function formatEta(s: number | undefined): string | undefined {
  if (s === undefined || !Number.isFinite(s)) return undefined;
  const r = Math.max(0, Math.round(s));
  return r < 60 ? `${r} s` : `${Math.floor(r / 60)} min ${r % 60} s`;
}

/** `[active] goto 10 -60 3, 24 blocks left, eta 6 s; [paused] gather 3/10 logs` for !status. */
export function formatStack(stack: readonly StackEntry[]): string {
  if (stack.length === 0) return 'idle';
  return stack
    .map((e) => {
      const eta = formatEta(e.etaS);
      const state = e.held ? 'held' : e.state === 'new' ? 'waiting' : e.state;
      return `[${state}] ${e.line}${eta ? `, eta ${eta}` : ''}`;
    })
    .join('; ');
}
