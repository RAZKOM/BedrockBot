// Walking as a process (PLAN.md 7.8, Track Q; docs/processes.md): `!goto x y z`, `!home go`, the
// return home after a guard fight / at dawn / after a respawn. Pre-empted = the navigator is
// cancelled and the goal kept; resumed = the same goal is planned again from where the bot stands.
// The caller's promise resolves once, when the walk really ends (or is stopped: `interrupted`).
//
// ETA (`!status`): the remaining length of the planned path (plus the heuristic distance beyond a
// partial path's end) divided by the speed measured in this goto (distance / ticks of the
// navigator's report), or the steady sprint / walk speed before 40 ticks have passed.
import type { Vec3 } from '../../connection/types.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import { steadySpeed } from '../../skills/nav/costs.ts';
import { goalTest, type Goal, type NavGoal } from '../../skills/nav/goals.ts';
import type { GotoReport } from '../../skills/nav/navigator.ts';
import type { GotoOptions, SkillResult } from '../../skills/types.ts';
import { BaseProcess, PRIORITY, type ProcessKind, type ProcessStatus, type StopReason } from './manager.ts';

/** What the goto process walks with (BotSkills satisfies it; usually wrapped by `settingsMover`). */
export interface ProcessMover {
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>; // every nav goal (getToBlock for chests)
  cancel(): void;
  readonly nav: { readonly busy: boolean; readonly lastReport?: GotoReport | undefined };
}

/**
 * Wrap the skills so every walk reads the live settings (allowBreak, allowPlace, closeDoors, sprint):
 * the caller's own options win, except that sprint needs both. Used for every process's walking.
 */
export function settingsMover<M extends ProcessMover>(skills: M, settings: RuntimeSettings): M {
  const goto = (goal: NavGoal, opts: GotoOptions = {}): Promise<SkillResult> =>
    skills.goto(goal, {
      allowBreak: settings.get('allowBreak'),
      allowPlace: settings.get('allowPlace'),
      closeDoors: settings.get('closeDoors'),
      closeTrapdoors: settings.get('closeTrapdoors'), // Track BG
      ...opts,
      sprint: (opts.sprint ?? true) && settings.get('sprint'),
    });
  return new Proxy(skills, {
    get(target, prop, receiver) {
      if (prop === 'goto') return goto;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** The navigator's internals the ETA reads (no public accessor yet; read-only, see docs/processes.md). */
interface NavInternals {
  active?: { goal: Goal; path: { x: number; feet: number; z: number }[]; passedAbs: number; status?: string };
}

/**
 * Blocks left along the navigator's current plan from `pos`, or undefined when it has none. Beyond a
 * partial plan's last node the goal heuristic (octile distance) is added.
 */
export function navRemaining(nav: unknown, pos: Vec3 | undefined): number | undefined {
  const a = (nav as NavInternals | undefined)?.active;
  if (!a || !pos || a.path.length === 0) return undefined;
  const from = Math.min(Math.max(0, a.passedAbs + 1), a.path.length - 1);
  const c = (n: { x: number; feet: number; z: number }) => ({ x: n.x + 0.5, y: n.feet, z: n.z + 0.5 });
  let len = 0;
  let prev = pos;
  for (let i = from; i < a.path.length; i++) {
    const p = c(a.path[i]!);
    len += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
    prev = p;
  }
  if (a.status === 'partial') {
    const last = a.path[a.path.length - 1]!;
    len += goalTest(a.goal).h(last.x, Math.floor(last.feet), last.z);
  }
  return len;
}

/** Blocks per tick: measured in this goto once it ran 40 ticks, else the steady speed. */
export function walkSpeed(report: GotoReport | undefined, sprint: boolean): number {
  if (report && report.ticks >= 40 && report.distance > 1) return report.distance / report.ticks;
  return steadySpeed(sprint);
}

/** Seconds for `remaining` blocks at the measured speed (20 ticks per second). */
export function etaFor(remaining: number | undefined, report: GotoReport | undefined, sprint: boolean): number | undefined {
  if (remaining === undefined) return undefined;
  return remaining / walkSpeed(report, sprint) / 20;
}

export function goalText(g: Goal): string {
  switch (g.type) {
    case 'block':
      return `${g.p.x} ${g.p.y} ${g.p.z}`;
    case 'near':
      return `${g.p.x.toFixed(1)} ${g.p.y.toFixed(1)} ${g.p.z.toFixed(1)}`;
    case 'xz':
      return `${g.x} ${g.z}`;
  }
}

export interface GotoProcessOptions {
  goal: Goal;
  opts?: GotoOptions;
  /** Behaviour line, e.g. `walking to 10 -60 3`, `returning home`. */
  label?: string;
  name?: string;
  kind?: ProcessKind;
  priority?: number;
  mover: ProcessMover;
  position: () => Vec3 | undefined;
  /** Sprint setting for the ETA's fallback speed. */
  sprint?: () => boolean;
  /** Done when within this horizontal distance of a block goal before starting (home return). */
  skipWithin?: number;
}

export class GotoProcess extends BaseProcess {
  readonly name: string;
  readonly kind: ProcessKind;
  private readonly prio: number;
  readonly goal: Goal;
  readonly label: string;
  readonly result: Promise<SkillResult>;
  /** Times the walk was pre-empted and resumed. */
  resumes = 0;
  private resolve!: (r: SkillResult) => void;
  private readonly o: GotoProcessOptions;

  constructor(o: GotoProcessOptions) {
    super();
    this.o = o;
    this.goal = o.goal;
    this.name = o.name ?? 'goto';
    this.kind = o.kind ?? 'user';
    this.prio = o.priority ?? (this.kind === 'user' ? PRIORITY.user : PRIORITY.home);
    this.label = o.label ?? `walking to ${goalText(o.goal)}`;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return this.prio;
  }

  protected run(t: number, resumed: boolean): void {
    if (resumed) this.resumes++;
    const g = this.goal;
    const pos = this.o.position();
    if (this.o.skipWithin !== undefined && pos && g.type === 'block' && Math.hypot(pos.x - (g.p.x + 0.5), pos.z - (g.p.z + 0.5)) <= this.o.skipWithin && Math.abs(pos.y - g.p.y) < 1.5) {
      this.end({ ok: true });
      return;
    }
    void this.o.mover.goto(g, this.o.opts).then(
      (r) => {
        if (t === this.token) this.end(r);
      },
      (e: unknown) => {
        if (t === this.token) this.end({ ok: false, reason: e instanceof Error ? e.message : String(e) });
      },
    );
  }

  protected halt(): void {
    if (this.o.mover.nav.busy) this.o.mover.cancel();
  }

  protected override onStopped(_reason: StopReason): void {
    this.resolve({ ok: false, reason: 'interrupted' });
  }

  private end(r: SkillResult): void {
    this.finish();
    this.resolve(r);
  }

  /** Blocks left on the plan (while it walks). */
  remaining(): number | undefined {
    return this.controlled ? navRemaining(this.o.mover.nav, this.o.position()) : undefined;
  }

  behaviour(): string {
    return this.label;
  }

  status(): ProcessStatus {
    const left = this.remaining();
    const sprint = (this.o.opts?.sprint ?? true) && (this.o.sprint?.() ?? true);
    const eta = etaFor(left, this.o.mover.nav.lastReport, sprint);
    return { line: `${this.label}${left !== undefined ? `, ${Math.round(left)} blocks left` : ''}`, etaS: eta };
  }
}
