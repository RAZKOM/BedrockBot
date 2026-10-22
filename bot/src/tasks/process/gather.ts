// Wood gathering as a process of the AFK task (PLAN.md 7.6 / 7.8, Track Q; docs/processes.md):
// `!gather N [x y z]` and `--chest x,y,z` on the afk task run GatherWoodTask (tasks/gatherWood.ts)
// as a user process. Pre-empted (guard, flee, night, a newer command) = GatherWoodTask.pause() (the
// running skill is cancelled, counters kept); resumed = GatherWoodTask.resume() (it goes on from
// find-tree, usually the half-felled tree, which is the nearest). It survives a death (paused while
// dead, resumed after the respawn, like `--task gather`). `--task gather` itself is unchanged.
import type { Vec3 } from '../../connection/types.ts';
import type { Logger } from '../../log.ts';
import { GatherWoodTask, logsIn, type GatherDeps, type GatherOptions, type GatherState } from '../gatherWood.ts';
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus, type StopReason } from './manager.ts';

export class GatherProcess extends BaseProcess {
  readonly name = 'gather';
  readonly kind = 'user' as const;
  override readonly survivesDeath = true;
  readonly result: Promise<GatherState>;
  private resolve!: (s: GatherState) => void;
  private started = false;
  private pausedAt: number | undefined;
  private pausedMs = 0;
  readonly task: GatherWoodTask;
  readonly opts: GatherOptions;

  constructor(task: GatherWoodTask, opts: GatherOptions) {
    super();
    this.task = task;
    this.opts = opts;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(): void {
    if (this.pausedAt !== undefined) {
      this.pausedMs += Date.now() - this.pausedAt;
      this.pausedAt = undefined;
    }
    if (!this.started) {
      this.started = true;
      void this.task.start(this.opts).then((s) => {
        // stopped by stop() resolves through onStopped; done / failed end the process here
        if (this.done) return;
        this.finish();
        this.resolve(s);
      });
      return;
    }
    this.task.resume();
  }

  protected halt(why: 'pause' | 'stop'): void {
    if (why === 'pause') {
      this.pausedAt = Date.now();
      this.task.pause('preempted');
    }
  }

  protected override onStopped(_reason: StopReason): void {
    if (this.started) this.task.stop();
    this.resolve('stopped');
  }

  /** Logs gathered so far: deposited (chest) or carried (no chest). */
  progress(): number {
    return this.opts.chest ? this.task.stats.deposited : Number(this.task.status().carried);
  }

  behaviour(): string {
    return `gathering ${this.progress()}/${this.opts.target} logs`;
  }

  status(): ProcessStatus {
    const st = this.task.status();
    const state = this.controlled ? String(st.state) : this.started ? 'paused' : 'waiting';
    const done = this.progress();
    const elapsedS = Number(st.elapsedS) - this.pausedMs / 1000;
    const etaS = this.started && done > 0 && elapsedS > 0 ? ((this.opts.target - done) * elapsedS) / done : undefined;
    return { line: `gather ${done}/${this.opts.target} logs (${state}, ${this.task.stats.treesFelled} trees)`, etaS };
  }
}

export interface AfkGatherOptions {
  deps: GatherDeps;
  processes: ProcessManager;
  /** Default chest (`--chest`, config tasks.afk.chest). */
  chest?: Vec3;
  searchRadius?: number;
  log: Logger;
  /** Tell the owner when a run ends by itself. */
  say?: (msg: string) => void;
}

/** The `!gather` command backend for the afk task. */
export class AfkGather {
  readonly task: GatherWoodTask;
  private readonly o: AfkGatherOptions;
  private chest: Vec3 | undefined;
  current: GatherProcess | undefined;

  constructor(o: AfkGatherOptions) {
    this.o = o;
    this.chest = o.chest;
    this.task = new GatherWoodTask({ ...o.deps, log: o.log });
  }

  /** `!gather N [x y z]` (also `--chest` with `tasks.afk.targetLogs`). Returns the reply. */
  start(n: number, at: Vec3 | undefined): string {
    if (at) this.chest = at;
    const chest = this.chest;
    const p = new GatherProcess(this.task, { target: n, ...(chest ? { chest } : {}), searchRadius: this.o.searchRadius ?? 48 });
    this.current = p;
    this.o.processes.add(p);
    void p.result.then((s) => {
      if (s !== 'stopped') this.o.say?.(`gather ${s}: ${this.task.stats.deposited || logsIn(this.o.deps.inventory.slots)}/${n} logs${this.task.lastError ? ` (${this.task.lastError})` : ''}`);
    });
    return `gathering ${n} logs${chest ? ` into the chest at ${chest.x} ${chest.y} ${chest.z}` : ' (no chest: keeping them)'}`;
  }

  stop(): string {
    const p = this.current;
    if (!p || p.done) return 'not gathering';
    this.o.processes.stop(p, 'stopped');
    return `stopped (${this.task.stats.deposited} logs deposited)`;
  }

  status(): string {
    const p = this.current;
    if (!p) return 'gather: idle';
    return `gather: ${p.status().line}${p.done ? ' (ended)' : ''}`;
  }

  /** At a death: count it (the manager pauses the process while dead). */
  onDeath(): void {
    if (this.current && !this.current.done && this.task.running) this.task.stats.deaths++;
  }
}
