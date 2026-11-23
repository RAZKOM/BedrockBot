// Track B4 (ADR 0129, docs/build.md "Shulker boxes"): a large build fed from shulker boxes on the flat fake world: the
// boxes out kept in the progress file, the job's cells no box goes on, the boxes a run before left picked up before
// anything is built, the box work as a user process of its own.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BuildJob, type JobDeps } from '../../../src/skills/build/job.ts';
import { planBuild, type PlanOptions } from '../../../src/skills/build/plan.ts';
import { BuildProgress, loadProgress } from '../../../src/skills/build/progress.ts';
import { BuildRunner } from '../../../src/skills/build/runner.ts';
import { parseSpec } from '../../../src/skills/build/spec.ts';
import { type BuildSpec, type Cell } from '../../../src/skills/build/types.ts';
import { BoxWorkProcess } from '../../../src/tasks/process/build.ts';
import { BaseProcess, PRIORITY, ProcessManager } from '../../../src/tasks/process/manager.ts';
import { FakeBot, FakeInventory, FlatWorld } from './build-fakes.ts';

const F = -60;
const START: Cell = { x: 0, y: F, z: 0 };

function spec(args: string): BuildSpec {
  const r = parseSpec(args.split(' '), { feet: START });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

function jobDeps(bot: FakeBot, extra: Partial<JobDeps> = {}): JobDeps {
  return {
    world: bot.world,
    position: () => bot.feet,
    plan: (s: BuildSpec, o: PlanOptions) => Promise.resolve(planBuild(bot.world, s, o)),
    runner: (plan, hooks) => new BuildRunner(plan, { ...bot.deps(), ...hooks }),
    options: { scaffold: true, maxColumn: 6, safeEdge: 3 },
    have: (it) => bot.inv.count(it),
    log: undefined,
    ...extra,
  };
}

describe('the boxes out in the progress file (Track B4)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b4-progress-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('saved at once when they change, loaded back, gone from the file when none are out; bad keys dropped', () => {
    const file = join(dir, 'p.json');
    const now = 0;
    const p = new BuildProgress(file, { args: ['floor'], feet: START, label: 'floor', kind: 'floor', box: { min: { x: 0, y: F, z: 0 }, max: { x: 3, y: F, z: 3 } }, total: 16, fetch: true }, { now: () => now });
    p.setBoxes({ standing: [{ x: -2, y: F, z: 1 }], left: [] });
    expect(loadProgress(file)?.boxes).toEqual({ standing: [`-2,${F},1`], left: [] });
    p.setBoxes({ standing: [], left: [{ x: 5, y: F, z: 5 }, { x: -2, y: F, z: 1 }] });
    const d = loadProgress(file)!;
    expect(d.boxes).toEqual({ standing: [], left: [`-2,${F},1`, `5,${F},5`] });
    expect(new BuildProgress(file, d).boxCells()).toEqual({ standing: [], left: [{ x: -2, y: F, z: 1 }, { x: 5, y: F, z: 5 }] });
    // the same boxes again: no write (the file's time stays)
    const before = readFileSync(file, 'utf8');
    p.setBoxes({ standing: [], left: [{ x: -2, y: F, z: 1 }, { x: 5, y: F, z: 5 }] });
    expect(readFileSync(file, 'utf8')).toBe(before);
    p.setBoxes({ standing: [], left: [] });
    expect(loadProgress(file)?.boxes).toBeUndefined();
    expect(new BuildProgress(file, { ...d, boxes: { standing: ['x,y,z', '1,2,3'], left: ['4,5'] } }).boxCells()).toEqual({ standing: [{ x: 1, y: 2, z: 3 }], left: [] });
  });
});

describe('the job and the boxes (Track B4)', () => {
  it('no box on any cell of the build (every section, done or not), on a planned stand of the running section; clear: its whole box', async () => {
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 100, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const s = spec(`floor 2 ${F} 2 9 9 stone`);
    const job = new BuildJob(s, START, jobDeps(bot), { max: 16 });
    expect(job.isBuildCell({ x: 2, y: F, z: 2 })).toBe(true);
    expect(job.isBuildCell({ x: 9, y: F, z: 9 })).toBe(true); // a later section's
    expect(job.isBuildCell({ x: 1, y: F, z: 2 })).toBe(false);
    expect(job.isBuildCell({ x: 2, y: F + 1, z: 2 })).toBe(false);
    const c = new BuildJob(spec(`clear 2 ${F} 2 4 ${F + 2} 4`), START, jobDeps(bot));
    expect(c.isBuildCell({ x: 3, y: F + 1, z: 3 })).toBe(true);
    expect(c.isBuildCell({ x: 5, y: F, z: 3 })).toBe(false);
    // the running section's stands come in through the runner
    let banned = false;
    bot.onStep = () => {
      if (banned) return;
      const r = (job as unknown as { runner?: BuildRunner }).runner;
      const st = r?.plan.steps.map((x) => ('stand' in x ? x.stand : undefined)).find((c) => c && !job.isBuildCell(c));
      if (st) banned = job.noBox(st) && !job.isBuildCell(st);
    };
    expect(await job.run()).toEqual({ state: 'done' });
    expect(banned).toBe(true);
  });

  it('the boxes a run before left are picked up before anything is built; a pause while it walks pauses the job', async () => {
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 25, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const s = spec(`floor 2 ${F} 2 6 6 stone`);
    const order: string[] = [];
    let pauseIt = true;
    const ref: { job?: BuildJob } = {};
    const deps = jobDeps(bot, {
      boxesFirst: async (cancelled) => {
        order.push(`boxes (placed ${bot.places})`);
        if (pauseIt) {
          pauseIt = false;
          ref.job!.pause();
        }
        await Promise.resolve();
        if (cancelled()) order.push('boxes cancelled');
      },
      cancel: () => order.push('cancel'),
    });
    const job = new BuildJob(s, START, deps);
    ref.job = job;
    expect(await job.run()).toEqual({ state: 'paused' });
    expect(order).toEqual(['boxes (placed 0)', 'cancel', 'boxes cancelled']);
    expect(await job.run()).toEqual({ state: 'done' });
    expect(order[3]).toBe('boxes (placed 0)');
    expect(job.stats.placed).toBe(25);
  });
});

describe('the box work as a user process (Track B4)', () => {
  class Other extends BaseProcess {
    readonly kind = 'user' as const;
    readonly name = 'other';
    get priority(): number {
      return PRIORITY.user;
    }
    protected run(): void {}
    protected halt(): void {}
    status() {
      return { line: 'other' };
    }
  }

  it('runs its work and ends with its line; pre-empted, it is cancelled and runs again when it has control back', async () => {
    const pm = new ProcessManager();
    let runs = 0;
    let release!: () => void;
    const cancels: number[] = [];
    const p = new BoxWorkProcess(
      'taking materials out of my shulker boxes',
      async (cancelled) => {
        runs++;
        if (runs === 1) {
          await new Promise<void>((r) => {
            release = r;
          });
          return cancelled() ? 'first run cancelled' : 'first run';
        }
        return `run ${runs}`;
      },
      () => {
        cancels.push(runs);
        release?.();
      },
    );
    pm.add(p);
    expect(p.status().line).toBe('build: taking materials out of my shulker boxes');
    expect(p.running).toBe(true);
    const o = pm.add(new Other());
    expect(cancels).toEqual([1]); // halted: the running skill cancelled
    expect(p.status().line).toMatch(/\(paused\)$/);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.running).toBe(false);
    pm.stop(o, 'stopped'); // the other process ends: control back
    expect(await p.result).toBe('run 2');
    expect(pm.userProcesses()).toEqual([]);
  });

  it('stopped: the result says why', async () => {
    const pm = new ProcessManager();
    const p = new BoxWorkProcess('picking up my shulker boxes', () => new Promise<string>(() => {}));
    pm.add(p);
    pm.stop(p, 'stopped');
    expect(await p.result).toBe('cancelled: stopped');
    expect(p.behaviour()).toBe('picking up my shulker boxes');
  });
});
