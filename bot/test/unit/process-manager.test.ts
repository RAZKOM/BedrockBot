// Process manager (PLAN.md 7.8, Track Q; docs/processes.md): a scripted pre-emption scenario with
// fake processes (priorities, pause / resume / release, the user stack, !pause / !resume / !stop,
// death, the stack shown by !status), plus the goto process's ETA and resume.
import { describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../src/config/settings.ts';
import type { Goal } from '../../src/skills/nav/goals.ts';
import type { GotoOptions, SkillResult } from '../../src/skills/types.ts';
import { etaFor, GotoProcess, navRemaining, settingsMover, walkSpeed, type ProcessMover } from '../../src/tasks/process/goto.ts';
import { BaseProcess, formatEta, formatStack, PRIORITY, ProcessManager, type ProcessKind, type ProcessStatus } from '../../src/tasks/process/manager.ts';

/** A process that records its lifecycle calls; `want` and `prio` are switched by the test. */
class Rec extends BaseProcess {
  readonly name: string;
  readonly kind: ProcessKind;
  prio: number;
  want = true;
  readonly log: string[];
  constructor(name: string, kind: ProcessKind, prio: number, log: string[], persistent = false) {
    super();
    this.name = name;
    this.kind = kind;
    this.prio = prio;
    this.log = log;
    this.persistent = persistent;
  }
  get priority(): number {
    return this.prio;
  }
  override wants(): boolean {
    return !this.done && this.want;
  }
  protected run(_t: number, resumed: boolean): void {
    this.log.push(`${this.name}:${resumed ? 'resume' : 'start'}`);
  }
  protected halt(why: 'pause' | 'stop'): void {
    this.log.push(`${this.name}:${why}`);
  }
  complete(): void {
    this.log.push(`${this.name}:done`);
    this.finish();
  }
  status(): ProcessStatus {
    return { line: `${this.name} line`, etaS: this.name === 'goto' ? 12.4 : undefined };
  }
}

describe('ProcessManager', () => {
  it('runs the highest priority, pauses (not stops) the pre-empted one and resumes it afterwards', () => {
    const log: string[] = [];
    const pm = new ProcessManager();
    const guard = new Rec('guard', 'auto', PRIORITY.guard, log, true);
    guard.want = false;
    pm.add(guard);
    const flee = new Rec('flee', 'auto', PRIORITY.flee, log, true);
    flee.want = false;
    pm.add(flee);
    pm.tick();
    expect(pm.active).toBeUndefined();

    // the owner's gather starts
    const gather = pm.add(new Rec('gather', 'user', PRIORITY.user, log));
    expect(pm.active).toBe(gather);
    // a hostile: guard pre-empts the gather (pause, not stop)
    guard.want = true;
    pm.tick();
    expect(pm.active).toBe(guard);
    // low health: flee pre-empts the fight
    flee.want = true;
    pm.tick();
    expect(pm.active).toBe(flee);
    expect(pm.stack().map((e) => `${e.name}:${e.state}`)).toEqual(['flee:active', 'guard:paused', 'gather:paused']);
    // safe again: the fight resumes, then the gather
    flee.want = false;
    pm.tick();
    expect(pm.active).toBe(guard);
    guard.want = false;
    pm.tick();
    expect(pm.active).toBe(gather);
    gather.complete();
    expect(pm.active).toBeUndefined();
    pm.tick();
    expect(log).toEqual([
      'gather:start',
      'gather:pause',
      'guard:start',
      'guard:pause',
      'flee:start',
      'flee:pause', // released: it no longer wants control
      'guard:resume',
      'guard:pause', // released
      'gather:resume',
      'gather:done',
    ]);
  });

  it('user commands stack (newest on top, same name replaces), !pause holds them, !stop ends them all', () => {
    const log: string[] = [];
    const pm = new ProcessManager();
    const night = pm.add(new Rec('night', 'auto', PRIORITY.night, log, true));
    night.want = false;
    const home = pm.add(new Rec('home', 'auto', PRIORITY.home, log));
    expect(pm.active).toBe(home);
    const follow = pm.add(new Rec('follow', 'user', PRIORITY.user, log));
    // a command drops a pending home return
    expect(pm.has(home)).toBe(false);
    expect(home.done).toBe(true);
    const goto1 = pm.add(new Rec('goto', 'user', PRIORITY.user, log));
    expect(pm.active).toBe(goto1);
    const goto2 = pm.add(new Rec('goto', 'user', PRIORITY.user, log));
    expect(goto1.done).toBe(true); // replaced
    expect(pm.active).toBe(goto2);
    expect(pm.stack().map((e) => e.name)).toEqual(['goto', 'follow']);
    expect(formatStack(pm.stack())).toBe('[active] goto line, eta 12 s; [paused] follow line');

    // !pause: commands held, auto processes still run
    expect(pm.hold()).toBe(true);
    expect(pm.active).toBeUndefined();
    expect(pm.stack().every((e) => e.held)).toBe(true);
    night.want = true;
    pm.tick();
    expect(pm.active).toBe(night);
    night.want = false;
    pm.tick();
    expect(pm.active).toBeUndefined();
    // !resume: the newest command continues
    expect(pm.unhold()).toBe(true);
    expect(pm.active).toBe(goto2);
    expect(pm.unhold()).toBe(false);

    // !stop: every command and what it pre-empted; night stays registered
    const stopped = pm.stopUser(['home']);
    expect(stopped).toEqual(['goto line', 'follow line']);
    expect(pm.active).toBeUndefined();
    expect(follow.done && goto2.done).toBe(true);
    expect(pm.has(night)).toBe(true);
    expect(log.filter((l) => l.startsWith('goto') || l.startsWith('follow'))).toEqual([
      'follow:start',
      'follow:pause',
      'goto:start',
      'goto:stop', // goto1 replaced
      'goto:start',
      'goto:pause', // held
      'goto:resume',
      'goto:stop',
    ]);
  });

  it('pauses everything while inactive (dead); at a death only processes that survive it stay', () => {
    const log: string[] = [];
    let dead = false;
    const pm = new ProcessManager({ inactive: () => dead });
    const follow = pm.add(new Rec('follow', 'user', PRIORITY.user, log));
    class Gather extends Rec {
      override readonly survivesDeath = true;
    }
    const gather = pm.add(new Gather('gather', 'user', PRIORITY.user, log));
    expect(pm.active).toBe(gather);
    dead = true;
    pm.onDeath();
    pm.tick();
    expect(pm.active).toBeUndefined();
    expect(follow.done).toBe(true);
    expect(gather.done).toBe(false);
    dead = false;
    pm.tick();
    expect(pm.active).toBe(gather);
    expect(log.slice(-2)).toEqual(['gather:pause', 'gather:resume']);
  });

  it('priority can change with the state; yieldControl restarts an active process', () => {
    const log: string[] = [];
    const pm = new ProcessManager();
    const night = pm.add(new Rec('night', 'auto', PRIORITY.night, log, true));
    const guard = pm.add(new Rec('guard', 'auto', PRIORITY.guard, log, true));
    expect(pm.active).toBe(night);
    guard.prio = PRIORITY.defend; // a hostile within reach inside the shelter
    pm.tick();
    expect(pm.active).toBe(guard);
    (guard as unknown as { yieldControl(): void }).yieldControl();
    expect(pm.active).toBe(guard);
    expect(log.slice(-2)).toEqual(['guard:pause', 'guard:start']);
    guard.want = false;
    pm.tick();
    expect(pm.active).toBe(night);
    expect(pm.busy()).toBe(true);
  });

  it('formats ETAs', () => {
    expect(formatEta(undefined)).toBeUndefined();
    expect(formatEta(4.4)).toBe('4 s');
    expect(formatEta(185)).toBe('3 min 5 s');
  });
});

class FakeNav {
  busy = false;
  lastReport: { ticks: number; distance: number } | undefined;
  active: unknown;
}

class FakeMover {
  readonly nav = new FakeNav();
  calls: { goal: Goal; opts: GotoOptions | undefined }[] = [];
  private pending: ((r: SkillResult) => void) | undefined;
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult> {
    this.cancel();
    this.calls.push({ goal, opts });
    this.nav.busy = true;
    return new Promise((r) => (this.pending = r));
  }
  cancel(): void {
    const p = this.pending;
    this.pending = undefined;
    this.nav.busy = false;
    p?.({ ok: false, reason: 'interrupted' });
  }
  finish(r: SkillResult): void {
    const p = this.pending;
    this.pending = undefined;
    this.nav.busy = false;
    p?.(r);
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('GotoProcess', () => {
  it('is resumed after a pre-emption (same goal planned again) and resolves once when it really ends', async () => {
    const mover = new FakeMover();
    const pm = new ProcessManager();
    const goal: Goal = { type: 'block', p: { x: 40, y: -60, z: 0 } };
    const g = pm.add(new GotoProcess({ goal, mover: mover as never, position: () => ({ x: 0.5, y: -60, z: 0.5 }) }));
    expect(mover.calls).toHaveLength(1);
    let result: SkillResult | undefined;
    void g.result.then((r) => (result = r));
    const log: string[] = [];
    const guard = pm.add(new Rec('guard', 'auto', PRIORITY.guard, log, true));
    expect(pm.active).toBe(guard);
    await tick();
    expect(result).toBeUndefined(); // the cancelled leg does not report
    guard.want = false;
    pm.tick();
    expect(mover.calls).toHaveLength(2);
    expect(mover.calls[1]!.goal).toEqual(goal);
    expect(g.resumes).toBe(1);
    mover.finish({ ok: true });
    await tick();
    expect(result).toEqual({ ok: true });
    expect(pm.active).toBeUndefined();
  });

  it('a stopped goto resolves interrupted; a home return within reach is done at once', async () => {
    const mover = new FakeMover();
    const pm = new ProcessManager();
    const g = pm.add(new GotoProcess({ goal: { type: 'block', p: { x: 5, y: -60, z: 5 } }, mover: mover as never, position: () => undefined }));
    pm.stopUser();
    expect(await g.result).toEqual({ ok: false, reason: 'interrupted' });
    const h = pm.add(new GotoProcess({ goal: { type: 'block', p: { x: 0, y: -60, z: 0 } }, kind: 'auto', name: 'home', mover: mover as never, position: () => ({ x: 0.7, y: -60, z: 0.4 }), skipWithin: 1 }));
    expect(await h.result).toEqual({ ok: true });
    expect(mover.calls).toHaveLength(1);
  });

  it('ETA: remaining path length over the measured speed', () => {
    const path = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((x) => ({ x, feet: -60, z: 0 }));
    const nav = { active: { goal: { type: 'block', p: { x: 10, y: -60, z: 0 } }, path, passedAbs: 2, status: 'found' } };
    // at x 2.5: nodes 3..10 left = 8 blocks
    expect(navRemaining(nav, { x: 2.5, y: -60, z: 0.5 })).toBeCloseTo(8, 6);
    // a partial plan adds the heuristic distance from its end to the goal
    const partial = { active: { ...nav.active, goal: { type: 'block', p: { x: 30, y: -60, z: 0 } }, status: 'partial' } };
    expect(navRemaining(partial, { x: 2.5, y: -60, z: 0.5 })).toBeCloseTo(28, 6);
    expect(navRemaining({}, { x: 0, y: 0, z: 0 })).toBeUndefined();
    // measured: 40 blocks in 200 ticks = 0.2 blocks per tick -> 8 blocks = 40 ticks = 2 s
    expect(etaFor(8, { ticks: 200, distance: 40 } as never, true)).toBeCloseTo(2, 6);
    // before 40 ticks: the steady sprint speed (1 / 3.564 ticks per block)
    expect(walkSpeed(undefined, true)).toBeCloseTo(1 / 3.564, 2);
  });

  it('settingsMover applies the live settings to every walk; the caller can still turn sprint off', async () => {
    const mover = new FakeMover();
    const s = new RuntimeSettings();
    const m = settingsMover(mover as unknown as ProcessMover, s);
    void m.goto({ type: 'xz', x: 1, z: 1 });
    expect(mover.calls.at(-1)!.opts).toEqual({ allowBreak: false, allowPlace: false, closeDoors: false, closeTrapdoors: true, sprint: true });
    s.set('allowBreak', 'on');
    s.set('sprint', 'off');
    void m.goto({ type: 'xz', x: 1, z: 1 }, { timeoutTicks: 5 });
    expect(mover.calls.at(-1)!.opts).toEqual({ allowBreak: true, allowPlace: false, closeDoors: false, closeTrapdoors: true, timeoutTicks: 5, sprint: false });
    s.set('sprint', 'on');
    void m.goto({ type: 'xz', x: 1, z: 1 }, { sprint: false, allowBreak: false });
    expect(mover.calls.at(-1)!.opts).toMatchObject({ allowBreak: false, sprint: false });
    expect(m.nav).toBe(mover.nav);
    m.cancel();
    await tick();
  });
});
