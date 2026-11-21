// Track E12 (`workGuard`, docs/early-game.md "The mine's dangers (Track E12)", ADR 0119): with guard off, a job at work
// has guard's fight take the archer that shoots at it and the witch near it. Off by default.
import { describe, expect, it, vi } from 'vitest';
import { BaseProcess, PRIORITY, type ProcessStatus } from '../../../src/tasks/process/manager.ts';
import { PveController, WORK_ARCHER_HEALTH, WORK_ARCHER_RANGE, WORK_ARCHERS_MAX } from '../../../src/tasks/pve.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const stack = (name: string): ItemStack => ({ name, networkId: 1, count: 1, metadata: 0 });

/** A user process standing for the job. */
class Job extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name: string;
  constructor(name: string) {
    super();
    this.name = name;
  }
  get priority(): number {
    return PRIORITY.user;
  }
  protected run(): void {}
  protected halt(): void {}
  status(): ProcessStatus {
    return { line: this.name };
  }
}

function setup(o: { on?: boolean; guard?: boolean; health?: number; blade?: boolean; job?: string | null } = {}) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const ents = new Map<bigint, EntityInfo>();
  const inventory = new Inventory(() => null, () => 1n);
  const me = loop.pos;
  const pve = new PveController({ source: src, world: { entities: ents, inventory, self: { runtimeId: 1n, health: o.health ?? 20 } }, loop, skills: Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) }), home: () => undefined, shelter: () => undefined, inactive: () => false, options: { guard: { on: o.guard ?? false, radius: 16 } } });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health: o.health ?? 20 });
  if (o.blade ?? true) inventory.setItem(0, 0, stack('stone_sword'));
  expect(pve.settings.get('workGuard')).toBe(true); // on by default (ADR 0119 addendum)
  pve.settings.set('workGuard', (o.on ?? true) ? 'on' : 'off'); // explicit both ways: the default is on (ADR 0119 addendum)
  if (o.job !== null) pve.processes.add(new Job(o.job ?? 'mine'));
  const at = (dx: number, dz = 0): Vec3 => ({ x: me.x + dx, y: me.y, z: me.z + dz });
  const aims = vi.spyOn(pve.mobs, 'targetsUs').mockReturnValue(true);
  return { pve, ents, me, at, aims, loop };
}

describe('workGuard: the archer that shoots at a job at work', () => {
  it('a skeleton within 16 that aims at the bot is the pick; guard wants the fight (60, not in place) and the job is paused for it', () => {
    const s = setup();
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', s.at(12)));
    expect(s.pve.workThreat(s.me)?.runtimeId).toBe(7n);
    expect(s.pve.guardProcess.wants()).toBe(true);
    expect(s.pve.guardProcess.priority).toBe(PRIORITY.guard);
    s.pve.dispose();
  });

  it(`not one that does not aim at the bot and has not hit it; not one farther than ${WORK_ARCHER_RANGE}`, () => {
    const s = setup();
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', s.at(12)));
    s.aims.mockReturnValue(false);
    expect(s.pve.workThreat(s.me)).toBeUndefined();
    s.aims.mockReturnValue(true);
    s.ents.get(7n)!.pos = s.at(WORK_ARCHER_RANGE + 0.5);
    expect(s.pve.workThreat(s.me)).toBeUndefined();
    s.pve.dispose();
  });

  it('off, guard on (its own picks), no blade in the hotbar, or below fleeHealth: no pick', () => {
    for (const o of [{ on: false }, { guard: true }, { blade: false }, { health: 7 }]) {
      const s = setup(o);
      s.ents.set(7n, mob(7n, 'minecraft:skeleton', s.at(10)));
      expect(s.pve.workThreat(s.me), JSON.stringify(o)).toBeUndefined();
      s.pve.dispose();
    }
  });

  it('only for work: not idle, not a walk the owner sent (goto, come, follow), not with a kill job, not under !pause', () => {
    for (const job of [null, 'goto', 'come', 'follow', 'kill']) {
      const s = setup({ job });
      s.ents.set(7n, mob(7n, 'minecraft:skeleton', s.at(10)));
      expect(s.pve.workThreat(s.me), String(job)).toBeUndefined();
      s.pve.dispose();
    }
    const p = setup();
    p.ents.set(7n, mob(7n, 'minecraft:skeleton', p.at(10)));
    p.pve.processes.hold();
    expect(p.pve.workThreat(p.me)).toBeUndefined();
    p.pve.dispose();
    const g = setup({ job: 'gather' });
    g.ents.set(7n, mob(7n, 'minecraft:skeleton', g.at(10)));
    expect(g.pve.workThreat(g.me)?.runtimeId).toBe(7n);
    g.pve.dispose();
  });

  it(`only while it is the only archer within ${WORK_ARCHER_RANGE} (${WORK_ARCHERS_MAX}), aiming or not; one farther does not count`, () => {
    const s = setup();
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', s.at(12)));
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', s.at(-10)));
    expect(s.pve.workThreat(s.me)).toBeUndefined();
    s.aims.mockImplementation((rid) => rid === 7n); // the second does not aim yet: it still counts
    expect(s.pve.workThreat(s.me)).toBeUndefined();
    s.ents.get(8n)!.pos = s.at(-(WORK_ARCHER_RANGE + 2));
    expect(s.pve.workThreat(s.me)?.runtimeId).toBe(7n);
    s.aims.mockReturnValue(true);
    s.ents.get(8n)!.pos = s.at(-10);
    s.ents.set(9n, mob(9n, 'minecraft:witch', s.at(0, 8)));
    expect(s.pve.workThreat(s.me)?.runtimeId).toBe(9n); // a witch still, with two archers
    s.pve.dispose();
  });

  it('a fight for the work on an archer ends when a second archer comes within range; the job goes on', () => {
    const s = setup();
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', s.at(12)));
    s.loop.step(2);
    expect(s.pve.guardProcess.fighting).toBe('skeleton');
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', s.at(-10)));
    s.loop.step(2);
    expect(s.pve.guardProcess.fighting).toBeUndefined();
    expect(s.pve.processes.active?.name).toBe('mine');
    s.pve.dispose();
  });

  it(`an archer fight starts only at ${WORK_ARCHER_HEALTH} health or more`, () => {
    const s = setup({ health: WORK_ARCHER_HEALTH - 1 });
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', s.at(12)));
    expect(s.pve.workThreat(s.me)).toBeUndefined();
    s.pve.dispose();
    const t = setup({ health: WORK_ARCHER_HEALTH });
    t.ents.set(7n, mob(7n, 'minecraft:skeleton', t.at(12)));
    expect(t.pve.workThreat(t.me)?.runtimeId).toBe(7n);
    t.pve.dispose();
  });

  it('a melee mob or a creeper is not its business (the reflex and the other rules as before)', () => {
    const s = setup();
    s.ents.set(7n, mob(7n, 'minecraft:zombie', s.at(5)));
    s.ents.set(8n, mob(8n, 'minecraft:creeper', s.at(0, 5)));
    expect(s.pve.workThreat(s.me)).toBeUndefined();
    expect(s.pve.guardProcess.wants()).toBe(false);
    s.pve.dispose();
  });
});

describe('workGuard: the witch near a job at work', () => {
  it('a witch within 12 in sight is the pick, before a nearer skeleton', () => {
    const s = setup();
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', s.at(6)));
    s.ents.set(9n, mob(9n, 'minecraft:witch', s.at(-10)));
    expect(s.pve.workThreat(s.me)?.runtimeId).toBe(9n);
    s.pve.dispose();
  });

  it('within her throw range also below fleeHealth (the flee leaves her alone by the same rule); farther at low health not', () => {
    const s = setup({ health: 6 });
    s.ents.set(9n, mob(9n, 'minecraft:witch', s.at(7)));
    expect(s.pve.fleeReason(s.me)).toBeUndefined(); // the witch-first rule: no flight from her
    expect(s.pve.workThreat(s.me)?.runtimeId).toBe(9n);
    s.ents.get(9n)!.pos = s.at(11);
    expect(s.pve.workThreat(s.me)).toBeUndefined();
    s.pve.dispose();
  });
});
