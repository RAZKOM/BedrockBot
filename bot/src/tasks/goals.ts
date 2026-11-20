// Standing goals (Track P4, ADR 0115, docs/queue.md "Standing goals"): one list of what the bot keeps up by itself.
// Each is an existing chore (an auto process at PRIORITY.chore behind its own setting): the food reserve, the milk,
// the rockets, the elytra, the farm, the night shell's blocks, the unload at home, the breeding. The list shows its
// switch (the setting, changed only by `!set`), its target (read from the settings), its last run and that run's
// line, and how it shares the body with the job queue. Nothing here changes what a chore does.
//
// A chore joins with one line where it is registered (the order does not matter):
//
//   registerGoal(d.task, { id: 'mend', label: 'mending', setting: 'autoMend', process: 'mendchore', target: (s) => `at ${s('mendAt')} %` });
import type { SettingKey } from '../config/settings.ts';
import { milkReply, type MilkReport } from './process/milk.ts';
import { rocketsReply, type RocketReport } from './process/rockets.ts';
import type { Process, ProcessManager } from './process/manager.ts';
import type { FoodJobResult } from './process/food.ts';
import type { RefillResult } from '../skills/survival/shell-blocks.ts';

/** A setting's value as the goals read it. */
export type GoalSettings = (key: SettingKey) => boolean | number | string;

export interface GoalDef {
  /** Short id (`food`). */
  id: string;
  /** What it keeps up (`food reserve`). */
  label: string;
  /** The on / off switch (a boolean setting). */
  setting: SettingKey;
  /** The chore's process name (an auto process). */
  process?: string;
  /** The target, read from the settings (`foodMin 10 hunger points`). */
  target?(s: GoalSettings): string | undefined;
  /** The last run's line, from the chore's own record (`last` on the chore); default the line it showed when it ran. */
  last?(chore: Process): string | undefined;
}

/** How a goal and the queue share the body right now. */
export type GoalRelation = 'running' | 'queue waits' | 'waits for the queue' | 'off' | 'idle';

export interface GoalView {
  id: string;
  label: string;
  setting: string;
  on: boolean;
  target: string | null;
  /** The chore holds the body now. */
  running: boolean;
  /** The last run: when it started (ms) and how long it took (s). */
  lastAt: number | null;
  lastS: number | null;
  lastLine: string | null;
  relation: GoalRelation;
}

/** A last run's line is cut to this (the panel's topic budget). */
export const LINE_MAX = 200;

const lastOf = <T>(p: Process): T | undefined => (p as unknown as { last?: T }).last;

/** The chores the afk task has (a chore that is not registered shows `idle` with no last run). */
export const DEFAULT_GOALS: readonly GoalDef[] = [
  {
    id: 'food',
    label: 'food reserve',
    setting: 'autoFood',
    process: 'food',
    target: (s) => `at least ${String(s('foodMin'))} hunger points carried`,
    last: (p) => {
      const r = lastOf<FoodJobResult>(p);
      return r ? `food: ${r.ok ? 'done' : 'stopped'} (${r.reason}), ${r.gained} items, ${r.killed} killed` : undefined;
    },
  },
  {
    id: 'milk',
    label: 'milk buckets',
    setting: 'autoMilk',
    process: 'milk',
    target: (s) => `${String(s('milkKeep'))} milk buckets`,
    last: (p) => {
      const r = lastOf<MilkReport>(p);
      return r ? milkReply(r) : undefined;
    },
  },
  {
    id: 'rockets',
    label: 'rockets',
    setting: 'autoRockets',
    process: 'rockets',
    target: (s) => `${String(s('fireworksKeep'))} rockets`,
    last: (p) => {
      const r = lastOf<RocketReport>(p);
      return r ? rocketsReply(r) : undefined;
    },
  },
  { id: 'elytra', label: 'a good elytra', setting: 'autoElytra', process: 'elytra', target: () => 'a better one on under 100 uses over the worn limit' },
  { id: 'farm', label: 'the farm', setting: 'farmFood', process: 'farmchore', target: () => 'harvest at a quarter ripe, or a loaf when food is short' },
  {
    id: 'shell',
    label: 'night shell blocks',
    setting: 'shellBlocks',
    process: 'blockschore',
    target: () => '10 blocks for the night shell',
    last: (p) => {
      const r = lastOf<RefillResult>(p);
      return r ? `blocks: ${r.before} -> ${r.after}, ${r.dug} dug${r.reason ? ` (${r.reason})` : ''}` : undefined;
    },
  },
  { id: 'unload', label: 'unload at home', setting: 'autoUnload', process: 'home-chore', target: () => 'over 8 stacks to unload, a full box, or under 4 free slots' },
  { id: 'breed', label: 'breeding', setting: 'autoBreed', process: 'breed', target: (s) => (String(s('chorePen')) === 'none' ? 'needs chorePen' : `the pen at ${String(s('chorePen'))}`) },
];

const extra = new WeakMap<object, GoalDef[]>();

/** A chore joins the list (one line where it is registered; before or after the queue's registration). */
export function registerGoal(task: object, def: GoalDef): void {
  const list = extra.get(task) ?? [];
  const i = list.findIndex((d) => d.id === def.id);
  if (i >= 0) list[i] = def;
  else list.push(def);
  extra.set(task, list);
}

/** The goals of a task: the defaults, then (or in place of a default with its id) the registered ones. */
export function goalDefs(task: object): GoalDef[] {
  const added = extra.get(task) ?? [];
  const out = DEFAULT_GOALS.filter((g) => !added.some((a) => a.id === g.id)).map((g) => g);
  return [...out, ...added];
}

export interface GoalsDeps {
  task: object;
  settings: GoalSettings;
  processes: Pick<ProcessManager, 'find' | 'onControl' | 'active'>;
  /** The queue now: a job runs, jobs wait (the relation column). */
  queue?(): { running: boolean; waiting: number };
  now?(): number;
}

interface RunRecord {
  at: number;
  s: number | null;
  line: string | null;
}

/** The standing goals of one afk task; their runs are taken from the process manager's control changes. */
export class StandingGoals {
  private readonly d: GoalsDeps;
  private readonly runs = new Map<string, RunRecord>();
  private readonly open = new Map<string, { at: number; line: string | null; p: Process }>();
  private readonly off: () => void;

  constructor(d: GoalsDeps) {
    this.d = d;
    this.off = d.processes.onControl((e) => {
      this.control(e.to);
    });
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private chore(name: string): Process | undefined {
    return this.d.processes.find(name).find((p) => p.kind === 'auto');
  }

  private control(to: string | undefined): void {
    this.sweep();
    const names = new Set(goalDefs(this.d.task).map((g) => g.process).filter((n): n is string => !!n));
    const a = this.d.processes.active;
    if (to && names.has(to) && a?.kind === 'auto' && a.name === to && this.open.get(to)?.p !== a) {
      let line: string | null = null;
      try {
        line = a.status().line;
      } catch {
        /* no line */
      }
      this.open.set(to, { at: this.now(), line, p: a });
    }
  }

  /**
   * Close every open run whose chore is no longer in control. Not every hand-back emits a control event (a chore that
   * yields to idle, a finished process), so this also runs on the queue's poll (every 250 ms) and before each list.
   */
  sweep(): void {
    if (this.open.size === 0) return;
    const a = this.d.processes.active;
    const now = this.now();
    for (const [name, o] of [...this.open]) {
      if (a === o.p) continue;
      this.open.delete(name);
      const def = goalDefs(this.d.task).find((g) => g.process === name);
      let line: string | null = o.line;
      try {
        line = def?.last?.(o.p) ?? o.line;
      } catch {
        /* the chore's record is its own */
      }
      this.runs.set(name, { at: o.at, s: Math.round((now - o.at) / 100) / 10, line });
    }
  }

  /** A goal's own reader that throws reads as `fallback` (one broken goal does not break the list). */
  private safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  list(): GoalView[] {
    this.sweep();
    const q = this.d.queue?.() ?? { running: false, waiting: 0 };
    const a = this.d.processes.active;
    return goalDefs(this.d.task).map((g) => {
      const on = this.safe(() => this.d.settings(g.setting) === true, false);
      const target = this.safe(() => g.target?.(this.d.settings) ?? null, null);
      const running = !!g.process && a?.kind === 'auto' && a.name === g.process;
      const open = g.process ? this.open.get(g.process) : undefined;
      const last = g.process ? this.runs.get(g.process) : undefined;
      let lastLine = last?.line ?? null;
      if (!lastLine && g.process && g.last) {
        const p = this.chore(g.process);
        try {
          lastLine = p ? (g.last(p) ?? null) : null;
        } catch {
          lastLine = null;
        }
      }
      const relation: GoalRelation = running ? (q.waiting > 0 && !q.running ? 'queue waits' : 'running') : !on ? 'off' : q.running ? 'waits for the queue' : 'idle';
      return {
        id: g.id,
        label: g.label,
        setting: g.setting,
        on,
        target,
        running,
        lastAt: open?.at ?? last?.at ?? null,
        lastS: open ? null : (last?.s ?? null),
        lastLine: lastLine && lastLine.length > LINE_MAX ? `${lastLine.slice(0, LINE_MAX - 3)}...` : lastLine,
        relation,
      };
    });
  }

  /** `!goals`: the list as chat parts. */
  parts(): string[] {
    const ago = (at: number): string => {
      const s = Math.max(0, Math.round((this.now() - at) / 1000));
      return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
    };
    return this.list().map((g) => {
      const rel = g.relation === 'running' ? ', running now' : g.relation === 'queue waits' ? ', running (the queue waits for it)' : g.relation === 'waits for the queue' ? ', waits for the queue' : '';
      const last = g.running ? '' : g.lastAt !== null ? `; last ${ago(g.lastAt)}${g.lastLine ? `: ${g.lastLine.slice(0, 80)}` : ''}` : '';
      return `${g.id} ${g.on ? 'on' : 'off'} (${g.setting}${g.target ? `; ${g.target}` : ''})${rel}${last}`;
    });
  }

  dispose(): void {
    this.off();
  }
}
