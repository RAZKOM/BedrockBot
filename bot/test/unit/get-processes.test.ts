/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Wave 8 Track AD: the stash step's call sites in the work processes (mine process tick, food job,
// gather task) on fakes: room after the step -> the job goes on; still full -> it ends `inventory full`.
import { describe, expect, it } from 'vitest';
import { setStash, type Stash } from '../../src/skills/container/stash.ts';
import type { Hunter } from '../../src/skills/food/hunter.ts';
import type { MineTask } from '../../src/skills/mine/miner.ts';
import { GatherWoodTask, type GatherDeps } from '../../src/tasks/gatherWood.ts';
import { FoodJob, type FoodDeps } from '../../src/tasks/process/food.ts';
import type { ProcessManager } from '../../src/tasks/process/manager.ts';
import { MineProcess } from '../../src/tasks/process/mine.ts';
import type { ItemStack } from '../../src/world/types.ts';

const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function fakeStash(answer: boolean, needed = true) {
  const jobs: unknown[] = [];
  const s = {
    needed: () => needed,
    ifFull: async (job: unknown) => {
      jobs.push(job);
      return answer;
    },
    cancel: () => undefined,
  };
  return { s: s as unknown as Stash, jobs };
}

function fakeMineTask() {
  const log: string[] = [];
  const t = {
    names: new Set(['coal_ore', 'deepslate_coal_ore']),
    state: 'walk',
    lastError: undefined as string | undefined,
    stats: { mined: 0, blacklisted: [], startedAt: 0 },
    get running() {
      return ['scan', 'walk', 'dig', 'collect', 'waiting', 'paused'].includes(t.state);
    },
    start: () => new Promise(() => undefined),
    pause: () => {
      log.push('pause');
      t.state = 'paused';
    },
    resume: () => {
      log.push('resume');
      t.state = 'scan';
    },
    stop: () => {
      log.push('stop');
      t.state = 'stopped';
    },
  };
  return { t, log };
}

describe('mine process: the stash step on tick', () => {
  it('pauses the task, stashes, resumes', async () => {
    const pm = { finished: () => undefined } as unknown as ProcessManager;
    const { s, jobs } = fakeStash(true);
    setStash(pm, s);
    const { t, log } = fakeMineTask();
    const p = new MineProcess(t as unknown as MineTask, { block: 'coal', count: 4 });
    p.attach(pm);
    p.start();
    p.tick();
    await flush();
    expect(log).toEqual(['pause', 'resume']);
    expect(jobs).toHaveLength(1);
    const wanted = (jobs[0] as { label: string; wanted: (n: string) => boolean });
    expect(wanted.label).toBe('mine');
    expect(wanted.wanted('coal')).toBe(true);
    expect(wanted.wanted('cobblestone')).toBe(false);
    expect(p.done).toBe(false);
  });

  it('still full: the job ends `inventory full`', async () => {
    const pm = { finished: () => undefined } as unknown as ProcessManager;
    setStash(pm, fakeStash(false).s);
    const { t, log } = fakeMineTask();
    const p = new MineProcess(t as unknown as MineTask, { block: 'coal', count: 4 });
    p.attach(pm);
    p.start();
    p.tick();
    await flush();
    expect(log).toEqual(['pause', 'stop']);
    expect(p.done).toBe(true);
    expect(await p.result).toBe('failed');
    expect(t.state).toBe('failed');
    expect(t.lastError).toBe('inventory full');
  });

  it('no stash registered, or room enough, or collecting: nothing happens', async () => {
    const { t, log } = fakeMineTask();
    const p = new MineProcess(t as unknown as MineTask, { block: 'coal', count: 4 });
    p.attach({ finished: () => undefined } as unknown as ProcessManager);
    p.start();
    p.tick();
    const pm = { finished: () => undefined } as unknown as ProcessManager;
    setStash(pm, fakeStash(true, false).s);
    p.attach(pm);
    p.tick();
    setStash(pm, fakeStash(true, true).s);
    t.state = 'collect';
    p.tick();
    await flush();
    expect(log).toEqual([]);
  });
});

describe('food job: the stash step before the hunt', () => {
  function deps(pm: object, hunted: string[]): FoodDeps {
    return {
      processes: pm as ProcessManager,
      settings: { get: () => 2 } as unknown as FoodDeps['settings'],
      hunter: {
        hunt: async () => {
          hunted.push('hunt');
          return { ok: true, reason: 'done', gained: 6, killed: 2, kinds: { cow: 2 }, fights: [] };
        },
      } as unknown as Hunter,
      cooker: {} as FoodDeps['cooker'],
      position: () => ({ x: 0, y: -60, z: 0 }),
      inventory: { slots: [] },
      isDay: () => true,
      cancel: () => undefined,
    };
  }

  it('room after the step: hunts', async () => {
    const pm = {};
    const { s, jobs } = fakeStash(true);
    setStash(pm, s);
    const hunted: string[] = [];
    const job = new FoodJob(6, { hunt: true, cook: false });
    expect(await job.run(deps(pm, hunted), () => false)).toBe(true);
    expect(hunted).toEqual(['hunt']);
    expect(jobs).toEqual([{ label: 'food' }]);
  });

  it('still full: the job is over with reason inventory_full, no hunt', async () => {
    const pm = {};
    setStash(pm, fakeStash(false).s);
    const hunted: string[] = [];
    const job = new FoodJob(6, { hunt: true, cook: false });
    expect(await job.run(deps(pm, hunted), () => false)).toBe(true);
    expect(hunted).toEqual([]);
    expect(job.result()).toMatchObject({ ok: false, reason: 'inventory_full', gained: 0 });
  });
});

describe('gather task: the stash step when full without a chest', () => {
  function deps(slots: (ItemStack | null)[]): GatherDeps {
    return {
      skills: {
        findTrees: () => [],
        cancel: () => undefined,
        status: () => ({}),
      } as unknown as GatherDeps['skills'],
      inventory: { slots, freeSlots: () => slots.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0) },
      position: () => ({ x: 0, y: -60, z: 0 }),
      ready: () => true,
      waitTicks: () => Promise.resolve(),
      corrections: () => 0,
    };
  }
  const full = () => Array.from({ length: 36 }, (): ItemStack | null => ({ name: 'dirt', count: 64, networkId: 3, metadata: 0 }));

  it('still full: ends `inventory full`', async () => {
    const g = new GatherWoodTask(deps(full()));
    const { s, jobs } = fakeStash(false);
    g.stash = s;
    expect(await g.start({ target: 4 })).toBe('failed');
    expect(g.lastError).toBe('inventory full');
    expect(jobs).toHaveLength(1);
    expect((jobs[0] as { label: string }).label).toBe('gather');
  });

  it('room after the step: goes on looking for trees', async () => {
    const slots = full();
    const g = new GatherWoodTask(deps(slots));
    g.stash = {
      ifFull: async () => {
        slots.fill(null);
        return true;
      },
    };
    expect(await g.start({ target: 4, noTreeRounds: 1 })).toBe('failed');
    expect(g.lastError).toMatch(/^no trees within/);
  });

  it('without the stash (the CLI gather task): the old `inventory full and no chest`', async () => {
    const g = new GatherWoodTask(deps(full()));
    expect(await g.start({ target: 4 })).toBe('failed');
    expect(g.lastError).toBe('inventory full and no chest');
  });
});
