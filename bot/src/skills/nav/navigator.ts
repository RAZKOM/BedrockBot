// goto (PLAN.md tasks 3.5 / 3.6): plans with A*, drives the InputLoop with a PathFollower, and
// re-plans when the server corrects us, when a block on the remaining path changes, when a partial
// path ends, or when the body makes no progress for `stuckTicks` ticks. After `maxFailures` stuck
// or failed plans it gives up with 'unreachable'. See docs/pathfinding.md.
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import type { InputLoop, InputLoopState } from '../input/inputLoop.ts';
import type { TerrainSource } from '../terrain/query.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { findPath, locateNode, type PathOptions, type PathResult } from './astar.ts';
import { PathFollower, PressGuard } from './follower.ts';
import type { Goal } from './goals.ts';
import { NavGrid } from './grid.ts';

/** What the navigator needs from the world model. `World` + `worldSource()` provide it. */
export interface NavWorld {
  source: TerrainSource;
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
}

export interface NavigatorOptions {
  logger?: Logger;
  /** Ticks without progress before a re-plan. Default 40. */
  stuckTicks?: number;
  /** Stuck events / failed plans before giving up. Default 3. */
  maxFailures?: number;
  path?: PathOptions;
  /** Max yaw change per tick while walking. Default 30. */
  maxTurnDeg?: number;
}

export type ReplanReason = 'start' | 'correction' | 'block' | 'partial' | 'stuck' | 'retry';

/** What happened during one goto (for tests, metrics and logs). */
export interface GotoReport {
  goal: Goal;
  result: SkillResult | undefined;
  ticks: number;
  /** Distance the body moved (sum of per-tick displacements), blocks. */
  distance: number;
  corrections: number;
  motions: number;
  plans: { reason: ReplanReason; tick: number; status: PathResult['status']; nodes: number; expanded: number; ms: number }[];
  stuck: number;
  failures: number;
  /** Ticks spent sprinting. */
  sprintTicks: number;
}

interface Active {
  goal: Goal;
  opts: Required<GotoOptions>;
  follower: PathFollower | undefined;
  guard: PressGuard;
  replan: ReplanReason | undefined;
  waitUntil: number;
  t: number;
  bestProgress: number;
  lastProgressTick: number;
  lastPos: Vec3 | undefined;
  report: GotoReport;
  finish: (r: SkillResult) => void;
}

export class Navigator {
  readonly grid: NavGrid;
  private readonly loop: InputLoop;
  private readonly log: Logger;
  private readonly stuckTicks: number;
  private readonly maxFailures: number;
  private readonly pathOpts: PathOptions;
  private readonly maxTurn: number;
  private active: Active | undefined;
  private readonly unsubs: (() => void)[] = [];
  /** Report of the last goto (also while it runs). */
  lastReport: GotoReport | undefined;

  constructor(loop: InputLoop, world: NavWorld, opts: NavigatorOptions = {}) {
    this.loop = loop;
    this.grid = new NavGrid(world.source);
    this.log = opts.logger ?? silentLogger;
    this.stuckTicks = opts.stuckTicks ?? 40;
    this.maxFailures = opts.maxFailures ?? 3;
    this.pathOpts = opts.path ?? {};
    this.maxTurn = opts.maxTurnDeg ?? 30;
    this.unsubs.push(
      world.onBlockUpdate((p) => {
        this.onBlock(p);
      }),
      loop.onEvent((e) => {
        const a = this.active;
        if (!a) return;
        if (e.kind === 'correction') {
          a.report.corrections++;
          if (a.opts.replanOnCorrection) a.replan ??= 'correction';
        } else if (e.kind === 'motion') {
          a.report.motions++;
          a.replan ??= 'correction';
        } else if (e.kind === 'teleport') {
          a.replan = 'correction';
        }
      }),
      loop.onBeforeStep((_tick, state) => {
        this.onTick(state);
      }),
    );
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  dispose(): void {
    this.cancel();
    for (const u of this.unsubs.splice(0)) u();
  }

  /** Plan only (no movement): from the body's current node to the goal. */
  plan(goal: Goal, from?: Vec3): PathResult | undefined {
    const start = locateNode(this.grid, from ?? this.loop.state.pos);
    return start && findPath(this.grid, start, goal, this.pathOpts);
  }

  goto(goal: Goal, options: GotoOptions = {}): Promise<SkillResult> {
    this.cancel();
    const opts: Required<GotoOptions> = {
      timeoutTicks: options.timeoutTicks ?? 6000,
      replanOnCorrection: options.replanOnCorrection ?? true,
      sprint: options.sprint ?? true,
    };
    return new Promise((resolve) => {
      const report: GotoReport = { goal, result: undefined, ticks: 0, distance: 0, corrections: 0, motions: 0, plans: [], stuck: 0, failures: 0, sprintTicks: 0 };
      this.lastReport = report;
      const a: Active = {
        goal,
        opts,
        follower: undefined,
        guard: new PressGuard(),
        replan: 'start',
        waitUntil: 0,
        t: 0,
        bestProgress: -Infinity,
        lastProgressTick: 0,
        lastPos: undefined,
        report,
        finish: (r) => {
          if (this.active !== a) return;
          this.active = undefined;
          report.result = r;
          this.loop.release();
          this.log.info(
            `goto ${JSON.stringify(goal)}: ${r.ok ? 'ok' : r.reason} after ${report.ticks} ticks, ${report.distance.toFixed(1)} blocks, ` +
              `${report.plans.length} plan(s), ${report.corrections} correction(s), ${report.stuck} stuck`,
          );
          resolve(r);
        },
      };
      this.active = a;
    });
  }

  cancel(): void {
    this.active?.finish({ ok: false, reason: 'interrupted' });
  }

  // ---- internals ---------------------------------------------------------------------------------

  private onBlock(p: Vec3): void {
    this.grid.invalidate(p.x, p.y, p.z);
    const a = this.active;
    if (!a?.follower) return;
    for (const n of a.follower.remaining()) {
      if (Math.abs(p.x - n.x) <= 1 && Math.abs(p.z - n.z) <= 1 && p.y >= n.y - 1 && p.y <= n.y + 2) {
        a.replan ??= 'block';
        return;
      }
    }
  }

  private fail(a: Active, why: string): boolean {
    a.report.failures++;
    this.log.info(`goto: failure ${a.report.failures}/${this.maxFailures} (${why})`);
    if (a.report.failures >= this.maxFailures) {
      a.finish({ ok: false, reason: 'unreachable' });
      return true;
    }
    return false;
  }

  private onTick(s: InputLoopState): void {
    const a = this.active;
    if (!a || !s.ready) return;
    a.t++;
    a.report.ticks = a.t;
    if (a.lastPos) a.report.distance += Math.hypot(s.pos.x - a.lastPos.x, s.pos.y - a.lastPos.y, s.pos.z - a.lastPos.z);
    a.lastPos = { ...s.pos };
    if (this.loop.command.sprint && s.onGround) a.report.sprintTicks++;
    if (a.t > a.opts.timeoutTicks) {
      a.finish({ ok: false, reason: 'timeout' });
      return;
    }

    if (a.replan && a.t >= a.waitUntil) {
      // plan from solid ground (an airborne body has no node yet), but do not wait forever
      if (s.onGround || a.t - a.lastProgressTick > 20 || !a.follower) {
        if (!this.replan(a, s)) {
          a.guard.idle();
          return;
        }
      }
    }
    const f = a.follower;
    if (!f) {
      this.loop.release();
      a.guard.idle();
      return;
    }

    const step = f.step(s, this.loop.command.yaw);
    this.loop.setCommand(step.cmd);
    if (step.done) {
      if (f.stopAtEnd) {
        a.finish({ ok: true });
      } else {
        a.replan ??= 'partial';
      }
      return;
    }

    const prog = f.progress(s.pos);
    if (prog > a.bestProgress + 0.05) {
      a.bestProgress = prog;
      a.lastProgressTick = a.t;
    } else if (a.t - a.lastProgressTick >= this.stuckTicks) {
      a.report.stuck++;
      this.log.info(`goto: no progress for ${this.stuckTicks} ticks at ${fmt(s.pos)} (node ${f.index}/${f.path.length - 1})`);
      if (this.fail(a, 'stuck')) return;
      a.replan = 'stuck';
      a.lastProgressTick = a.t;
    }
  }

  /** Returns false when the goto finished or must wait. */
  private replan(a: Active, s: InputLoopState): boolean {
    const reason = a.replan ?? 'retry';
    a.replan = undefined;
    const start = locateNode(this.grid, s.pos);
    if (!start) {
      a.follower = undefined;
      this.loop.release();
      if (this.fail(a, `no standable node at ${fmt(s.pos)}`)) return false;
      a.replan = 'retry';
      a.waitUntil = a.t + 20;
      return false;
    }
    if (a.goal.type === 'block') {
      // a block goal nobody can stand in (water, a wall, mid-air) is unreachable, whatever the search says
      const g = a.goal.p;
      if (Number.isNaN(this.grid.stand(Math.floor(g.x), Math.floor(g.y), Math.floor(g.z)))) {
        a.finish({ ok: false, reason: 'unreachable' });
        return false;
      }
    }
    const res = findPath(this.grid, start, a.goal, this.pathOpts);
    a.report.plans.push({ reason, tick: a.t, status: res.status, nodes: res.path.length, expanded: res.expanded, ms: +res.ms.toFixed(2) });
    this.log.debug(`goto: plan (${reason}) ${res.status}, ${res.path.length} nodes, ${res.expanded} expanded, ${res.ms.toFixed(1)} ms`);
    if (res.status === 'none') {
      a.finish({ ok: false, reason: 'unreachable' });
      return false;
    }
    const atGoal = res.status === 'found';
    if (res.path.length === 1 && !atGoal) {
      // the closest reachable node is where we stand: nothing to do but wait for the world to change
      a.follower = undefined;
      this.loop.release();
      if (this.fail(a, 'no progress possible')) return false;
      a.replan = 'retry';
      a.waitUntil = a.t + 20;
      return false;
    }
    a.follower = new PathFollower(res.path, this.grid, { sprint: a.opts.sprint, stopAtEnd: atGoal, maxTurnDeg: this.maxTurn, guard: a.guard });
    a.bestProgress = -Infinity;
    a.lastProgressTick = a.t;
    return true;
  }
}

function fmt(v: Vec3): string {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}
