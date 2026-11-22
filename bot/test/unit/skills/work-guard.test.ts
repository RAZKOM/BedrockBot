// Track E12 (`workGuard`, docs/early-game.md "The mine's dangers (Track E12)", ADR 0119): with guard off, a job at work
// has guard's fight take the archer that shoots at it and the witch near it. On by default (ADR 0119 addendum). Track M11:
// a witch fought for the work and not killed is held (fought again, the work standing still) while she is within 16.
import { describe, expect, it, vi } from 'vitest';
import { BaseProcess, PRIORITY, type ProcessStatus } from '../../../src/tasks/process/manager.ts';
import type { FightResult } from '../../../src/skills/combat/combat.ts';
import { PveController, WORK_ARCHER_HEALTH, WORK_ARCHER_RANGE, WORK_ARCHERS_MAX, WORK_WITCH_HOLD_MS, WORK_WITCH_HOLD_RANGE, WORK_WITCH_REFIGHT_MS, WORK_WITCH_UNREACHABLE_MAX } from '../../../src/tasks/pve.ts';
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

describe('workGuard (Track M11): a witch fought for the work and not dead is held', () => {
  const ended = (rid: bigint, reason: FightResult['reason']): FightResult => ({ ok: reason === 'killed', reason, runtimeId: rid, type: 'minecraft:witch', ticks: 63, attacks: 0, hits: 0 }) as unknown as FightResult;

  it('a fight that ended unreachable: not ignored 30 s, fought again after the pause; the work stands still in between', () => {
    const s = setup();
    const w = mob(9n, 'minecraft:witch', s.at(-8, 3));
    s.ents.set(9n, w);
    expect(s.pve.workThreat(s.me)?.runtimeId).toBe(9n);
    // the fight's end as guard sees it: targeting.afterFight ignores her 30 s (PATH_IGNORE_MS), then the hold
    s.pve.ignore.set(9n, performance.now() + 30_000);
    s.pve.workWitchFought(w, ended(9n, 'unreachable'));
    expect(s.pve.workWitch).toMatchObject({ rid: 9n, fights: 1 });
    expect(s.pve.workThreat(s.me)).toBeUndefined(); // within the pause
    expect(s.pve.heldWorkWitch(s.me)?.runtimeId).toBe(9n);
    expect(s.pve.guardProcess.wants()).toBe(true); // the hold
    s.loop.step(2);
    expect(s.pve.processes.active?.name).toBe('guard');
    expect(s.pve.guardProcess.behaviour()).toBe('holding the work: witch fought and not dead');
    expect(s.pve.guardProcess.workHolds).toBe(1);
    s.pve.workWitch!.endedAt -= WORK_WITCH_REFIGHT_MS + 1;
    expect(s.pve.workThreat(s.me)?.runtimeId).toBe(9n); // fought again although the ignore runs 30 s
    // another witch, not held, stays ignored as before
    const o = mob(10n, 'minecraft:witch', s.at(6));
    s.ents.set(10n, o);
    s.pve.ignore.set(10n, performance.now() + 30_000);
    s.ents.delete(9n);
    expect(s.pve.workThreat(s.me)).toBeUndefined();
    s.pve.dispose();
  });

  it(`the hold ends: her death, out of ${WORK_WITCH_HOLD_RANGE} and not aiming, ${WORK_WITCH_HOLD_MS / 1000} s, no job at work; a kill holds nothing`, () => {
    const s = setup();
    const w = mob(9n, 'minecraft:witch', s.at(-8, 3));
    s.ents.set(9n, w);
    s.pve.workWitchFought(w, ended(9n, 'killed'));
    expect(s.pve.workWitch).toBeUndefined();
    s.pve.workWitchFought(w, ended(9n, 'unreachable'));
    s.ents.delete(9n); // dead or gone
    expect(s.pve.heldWorkWitch(s.me)).toBeUndefined();
    expect(s.pve.workWitch).toBeUndefined();
    s.ents.set(9n, w);
    s.pve.workWitchFought(w, ended(9n, 'out_of_range'));
    w.pos = s.at(-(WORK_WITCH_HOLD_RANGE + 2));
    expect(s.pve.heldWorkWitch(s.me)?.runtimeId).toBe(9n); // farther but aiming
    s.aims.mockReturnValue(false);
    expect(s.pve.heldWorkWitch(s.me)).toBeUndefined();
    s.aims.mockReturnValue(true);
    w.pos = s.at(-8);
    s.pve.workWitchFought(w, ended(9n, 'timeout'));
    s.pve.workWitch!.since -= WORK_WITCH_HOLD_MS + 1;
    expect(s.pve.heldWorkWitch(s.me)).toBeUndefined();
    s.pve.dispose();
    const n = setup({ job: null });
    n.ents.set(9n, w);
    n.pve.workWitchFought(w, ended(9n, 'unreachable'));
    expect(n.pve.heldWorkWitch(n.me)).toBeUndefined();
    expect(n.pve.guardProcess.wants()).toBe(false);
    n.pve.dispose();
  });

  it(`${WORK_WITCH_UNREACHABLE_MAX} fights in a row that ended unreachable end the hold; the fight's ignore then applies`, () => {
    const s = setup();
    const w = mob(9n, 'minecraft:witch', s.at(-8, 3));
    s.ents.set(9n, w);
    s.pve.workWitchFought(w, ended(9n, 'unreachable'));
    s.pve.workWitchFought(w, ended(9n, 'interrupted')); // a fight that got somewhere resets the count
    s.pve.workWitchFought(w, ended(9n, 'unreachable'));
    expect(s.pve.workWitch).toMatchObject({ rid: 9n, fights: 3, unreachable: 1 });
    s.pve.ignore.set(9n, performance.now() + 30_000);
    s.pve.workWitchFought(w, ended(9n, 'unreachable'));
    expect(s.pve.workWitch).toBeUndefined();
    expect(s.pve.heldWorkWitch(s.me)).toBeUndefined();
    expect(s.pve.workThreat(s.me)).toBeUndefined(); // ignored 30 s, as before Track M11
    s.pve.dispose();
  });

  it('the health rule still decides the fight: held at low health from 11 off, no fight (the flee rules as before)', () => {
    const s = setup({ health: 6 });
    const w = mob(9n, 'minecraft:witch', s.at(11));
    s.ents.set(9n, w);
    s.pve.workWitchFought(w, ended(9n, 'interrupted'));
    s.pve.workWitch!.endedAt -= WORK_WITCH_REFIGHT_MS + 1;
    expect(s.pve.workThreat(s.me)).toBeUndefined();
    expect(s.pve.heldWorkWitch(s.me)?.runtimeId).toBe(9n);
    s.pve.dispose();
  });
});
