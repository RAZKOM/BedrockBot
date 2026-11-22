// Track E13 (`workArchers`, docs/early-game.md "Two archers at the work (Track E13)", ADR 0120): two archers or more
// shooting at a job at work: wall in, eat, open once fewer than two are within range (tasks/work-archers.ts).
import { describe, expect, it, vi } from 'vitest';
import { BaseProcess, PRIORITY, ProcessManager, type ProcessStatus } from '../../src/tasks/process/manager.ts';
import { PveController } from '../../src/tasks/pve.ts';
import { ARCHERS_REACH, archersPress, ArchersProcess, CLEAR_MS, HOLD_HEALTH, RETRY_MS, SHELL_HIT, SHELL_HIT_RETRY_MS, WAIT_MS, type ArcherSeen, type ArchersHost, type ArchersView } from '../../src/tasks/work-archers.ts';
import type { SealDeps } from '../../src/skills/survival/seal.ts';
import { Inventory } from '../../src/world/inventory.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './skills/pve-fakes.ts';

const me = { x: 10.5, y: -60, z: 20.5 };
const archer = (id: bigint, dx: number, dz: number, shooting = true): ArcherSeen => ({ id, feet: { x: me.x + dx, y: me.y, z: me.z + dz }, d: Math.hypot(dx, dz), shooting });
const JOB = {};
const view = (o: Partial<ArchersView> = {}): ArchersView => ({ me, job: JOB, archers: [archer(1n, -12, 0), archer(2n, -8, 9, false)], close: false, canCover: true, ...o });

describe('archersPress', () => {
  it('two archers within range at a job at work, one of them shooting', () => {
    expect(archersPress(view())).toBe(true);
  });
  it('not one archer (workGuard fights it), not two that do not shoot', () => {
    expect(archersPress(view({ archers: [archer(1n, -12, 0)] }))).toBe(false);
    expect(archersPress(view({ archers: [archer(1n, -12, 0, false), archer(2n, -8, 9, false)] }))).toBe(false);
  });
  it(`not with an archer within ${ARCHERS_REACH} (the reflex strikes it), not with a melee mob or a creeper close, not without a job at work`, () => {
    expect(archersPress(view({ archers: [archer(1n, -3, 0), archer(2n, -8, 9)] }))).toBe(false);
    expect(archersPress(view({ close: true }))).toBe(false);
    expect(archersPress(view({ job: undefined }))).toBe(false);
  });
});

/** A user process standing for the job (the mine). */
class Job extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name: string;
  stopped = false;
  constructor(name = 'mine') {
    super();
    this.name = name;
  }
  get priority(): number {
    return PRIORITY.user;
  }
  protected run(): void {}
  protected halt(): void {}
  protected override onStopped(): void {
    this.stopped = true;
  }
  status(): ProcessStatus {
    return { line: this.name };
  }
}

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`;

function setup(o: { on?: boolean; v?: ArchersView; blocks?: number } = {}) {
  let now = 1000;
  let v: ArchersView | undefined = o.v ?? view();
  let near: Vec3[] = [v.archers[0]!.feet, v.archers[1]!.feet];
  let health = 20;
  const solid = new Set<string>();
  // the ground under the feet row
  for (let x = 5; x <= 16; x++) for (let z = 15; z <= 26; z++) solid.add(key({ x, y: -61, z }));
  const placed: Vec3[] = [];
  const dug: Vec3[] = [];
  const stops: string[] = [];
  const lines: string[] = [];
  let bites = 0;
  let food = 20;
  const m = new ProcessManager();
  const job = m.add(new Job());
  const deps: SealDeps = {
    place: (p) => {
      solid.add(key(p));
      placed.push(p);
      return Promise.resolve({ ok: true });
    },
    dig: (p) => {
      solid.delete(key(p));
      dug.push(p);
      return Promise.resolve({ ok: true });
    },
    solid: (x, y, z) => solid.has(key({ x, y, z })),
    position: () => me,
    threats: () => near,
    slots: () => [{ name: 'minecraft:cobblestone', count: o.blocks ?? 16, networkId: 1, metadata: 0 }],
  };
  const host: ArchersHost = {
    enabled: () => o.on ?? true,
    view: () => (v && m.active === job ? v : v ? { ...v, job: undefined } : undefined),
    archersNear: () => near,
    health: () => health,
    food: () => food,
    eat: () => {
      bites++;
      food = 20;
      return Promise.resolve(true);
    },
    sealDeps: () => deps,
    stopJob: (j, why) => {
      stops.push(why);
      m.stop(j as Job, 'stopped');
    },
    cancel: () => {},
    stand: () => {},
    now: () => now,
    log: { info: (s: string) => lines.push(s), warn: (s: string) => lines.push(s), error: (s: string) => lines.push(s), debug: () => {} },
  };
  // the job at work is the Job process (the host's view gives it only while the job is the active process)
  if (v.job) v = { ...v, job };
  const p = m.add(new ArchersProcess(host));
  return {
    m,
    job,
    p,
    placed,
    dug,
    stops,
    lines,
    get bites() {
      return bites;
    },
    setNear: (x: Vec3[]) => {
      near = x;
    },
    setHealth: (h: number) => {
      health = h;
    },
    setFood: (f: number) => {
      food = f;
    },
    advance: (ms: number) => {
      now += ms;
    },
    ticks: async (n: number) => {
      for (let i = 0; i < n; i++) {
        m.tick();
        await flush();
      }
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('ArchersProcess', () => {
  it('pre-empts the job and walls in (the 9 cells, the side facing the nearest archer first), then waits', async () => {
    const s = setup();
    s.m.tick();
    expect(s.m.active?.name).toBe('archers');
    expect(s.p.priority).toBe(PRIORITY.flee);
    await s.ticks(15);
    expect(s.placed.length).toBeGreaterThanOrEqual(9);
    expect(s.placed[0]).toEqual({ x: 9, y: -60, z: 20 }); // the -x side: the archer 12 off on -x
    expect(s.p.phase).toBe('hold');
    expect(s.lines.some((l) => l.includes('walled in'))).toBe(true);
    expect(s.p.counts.covers).toBe(1);
  });

  it('eats in the shell while the food is under 20', async () => {
    const s = setup();
    s.m.tick();
    await s.ticks(15);
    s.setFood(15);
    await s.ticks(10);
    expect(s.bites).toBe(1);
  });

  it(`opens the side away from the archers and gives the job back once fewer than two are within range for ${CLEAR_MS / 1000} s at full health`, async () => {
    const s = setup();
    s.m.tick();
    await s.ticks(15);
    s.setNear([{ x: me.x - 12, y: me.y, z: me.z }]);
    s.setHealth(HOLD_HEALTH - 1);
    s.advance(CLEAR_MS + 1);
    await s.ticks(15);
    expect(s.p.phase).toBe('hold'); // not at full health
    s.setHealth(HOLD_HEALTH);
    await s.ticks(10);
    s.advance(CLEAR_MS + 1);
    await s.ticks(15);
    expect(s.dug).toEqual([
      { x: 11, y: -60, z: 20 },
      { x: 11, y: -60 + 1, z: 20 },
    ]);
    expect(s.m.active?.name).toBe('mine');
    expect(s.p.counts.cleared).toBe(1);
    expect(s.job.stopped).toBe(false);
  });

  it(`a job that waited ${WAIT_MS / 1000} s with the archers still there is stopped; the shell stays shut`, async () => {
    const s = setup();
    s.m.tick();
    await s.ticks(15);
    s.advance(WAIT_MS + 1);
    await s.ticks(15);
    expect(s.stops).toHaveLength(1);
    expect(s.stops[0]).toContain('2 archers still within 16');
    expect(s.job.stopped).toBe(true);
    expect(s.dug).toEqual([]);
    expect(s.p.counts.stopped).toBe(1);
  });

  it(`hit in the shell (${SHELL_HIT} under the best health there: an open cell, a blast): out of it, and no shell for ${SHELL_HIT_RETRY_MS / 1000} s`, async () => {
    const s = setup();
    s.m.tick();
    await s.ticks(15);
    expect(s.p.phase).toBe('hold');
    s.setHealth(19); // one under: not a hit (regeneration, rounding)
    await s.ticks(10);
    expect(s.p.phase).toBe('hold');
    s.setHealth(20 - SHELL_HIT);
    await s.ticks(10);
    expect(s.m.active?.name).toBe('mine');
    expect(s.p.counts.hit).toBe(1);
    expect(s.job.stopped).toBe(false);
    s.setHealth(20);
    s.advance(SHELL_HIT_RETRY_MS - 100);
    s.m.tick();
    expect(s.m.active?.name).toBe('mine');
    s.advance(200);
    s.m.tick();
    expect(s.m.active?.name).toBe('archers');
  });

  it(`waits ${RETRY_MS / 1000} s after a shell opened before another`, async () => {
    const s = setup();
    s.m.tick();
    await s.ticks(15);
    s.setNear([]);
    await s.ticks(10);
    s.advance(CLEAR_MS + 1);
    await s.ticks(15);
    expect(s.m.active?.name).toBe('mine');
    s.setNear([{ x: 0, y: -60, z: 20 }, { x: 2, y: -60, z: 29 }]);
    s.advance(RETRY_MS - 100);
    s.m.tick();
    expect(s.m.active?.name).toBe('mine');
    s.advance(200);
    s.m.tick();
    expect(s.m.active?.name).toBe('archers');
    expect(s.p.counts.covers).toBe(2);
  });

  it('off, or no shell possible here: nothing', () => {
    const s = setup({ on: false });
    s.m.tick();
    expect(s.m.active?.name).toBe('mine');
    const t = setup({ v: view({ canCover: false }) });
    t.m.tick();
    expect(t.m.active?.name).toBe('mine');
  });
});

describe('PveController: the archers it counts', () => {
  const stack = (name: string): ItemStack => ({ name, networkId: 1, count: 1, metadata: 0 });
  function pveSetup() {
    const src = new FakeSource();
    const loop = new FakeLoop();
    const ents = new Map<bigint, EntityInfo>();
    const inventory = new Inventory(() => null, () => 1n);
    const pve = new PveController({ source: src, world: { entities: ents, inventory, self: { runtimeId: 1n, health: 20 } }, loop, skills: Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) }), home: () => undefined, shelter: () => undefined, inactive: () => false, options: { guard: { on: false, radius: 16 } } });
    src.emit('start_game', { entity_id: -42n });
    src.emit('set_health', { health: 20 });
    inventory.setItem(0, 0, stack('stone_sword'));
    pve.settings.set('workGuard', 'on');
    pve.processes.add(new Job());
    const at = (dx: number, dz = 0): Vec3 => ({ x: loop.pos.x + dx, y: loop.pos.y, z: loop.pos.z + dz });
    vi.spyOn(pve.mobs, 'targetsUs').mockReturnValue(true);
    return { pve, ents, at, me: loop.pos };
  }

  it('the parched is an archer: the work fight takes a lone one, and two count for the rule', () => {
    const s = pveSetup();
    s.ents.set(7n, mob(7n, 'minecraft:parched', s.at(12)));
    expect(s.pve.workThreat(s.me)?.runtimeId).toBe(7n);
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', s.at(-10, 4)));
    expect(s.pve.workThreat(s.me)).toBeUndefined(); // two archers within 16: not workGuard's
    expect(s.pve.archersSeen(s.me).map((a) => a.id).sort()).toEqual([7n, 8n]);
    s.pve.dispose();
  });

  it('on by default; the job at work is the active user job with guard off; set off, the process wants nothing', () => {
    const s = pveSetup();
    expect(s.pve.settings.get('workArchers')).toBe(false); // ships off (ADR 0120: the fresh worlds' totals were worse)
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', s.at(12)));
    s.ents.set(8n, mob(8n, 'minecraft:stray', s.at(-10, 4)));
    s.pve.processes.tick();
    expect(s.pve.workJob()?.name).toBe('mine');
    s.pve.settings.set('workArchers', 'off');
    expect(s.pve.archersProcess.wants()).toBe(false);
    s.pve.dispose();
  });

  it('guard on: no job at work for the rule (guard fights them itself)', () => {
    const s = pveSetup();
    s.pve.processes.tick();
    expect(s.pve.workJob()?.name).toBe('mine');
    s.pve.setGuard({ on: true });
    expect(s.pve.workJob()).toBeUndefined();
    s.pve.dispose();
  });
});
