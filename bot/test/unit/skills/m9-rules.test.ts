// Track M9 (docs/pve.md "Track M9: losing a following archer", ADR 0079 addendum): the guard tests for this track's rules.
import { describe, expect, it, vi } from 'vitest';
import { SPRINT_JUMP_AIM, SPRINT_JUMP_ERR, sprintJumpOk } from '../../../src/skills/nav/follower.ts';
import { FLEE_AWAY, FLEE_FAR, FOLLOW_RUN, followRunRadius, PveController, PVE_RULES_DEFAULT, SPRINT_JUMP_FOOD } from '../../../src/tasks/pve.ts';
import { BLADE_CRAFT_HEALTH, BLADE_ITEMS, bladeNow } from '../../../src/tasks/process/blade.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const F = -60;

function controller(health: number, home: Vec3 | undefined) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const ents = new Map<bigint, EntityInfo>();
  const mover = Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) });
  const self = { runtimeId: 1n, health, food: 20 };
  const pve = new PveController({ source: src, world: { entities: ents, inventory: new Inventory(() => null, () => 1n), self }, loop, skills: mover, home: () => home, shelter: () => undefined, inactive: () => false, options: { guard: { on: true, radius: 16 } } });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health });
  pve.settings.set('mobReflex', false);
  return { src, loop, ents, pve, mover, self };
}


describe('the long far leg from a following archer (followRun)', () => {
  it(`followRunRadius: ${FOLLOW_RUN} past the archer, no FLEE_FAR cap; with no archer distance from FLEE_AWAY`, () => {
    expect(PVE_RULES_DEFAULT.followRun).toBe(true); // shipped on (choice-only)
    expect(followRunRadius(11.5)).toBe(11.5 + FOLLOW_RUN);
    expect(followRunRadius(30)).toBeGreaterThan(FLEE_FAR);
    expect(followRunRadius(Infinity)).toBe(FLEE_AWAY + FOLLOW_RUN);
  });

  it('a far leg with a pillager following is the long leg (on), the usual radius (off)', () => {
    for (const on of [false, true]) {
      const s = controller(20, { x: 0, y: F, z: 0 });
      s.pve.rules.followRun = on;
      const me = { x: 30.5, y: F, z: 0.5 };
      s.loop.pos = me;
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: me.x - 9, y: F, z: me.z }));
      s.pve.setGuard({ on: true, radius: 16 });
      s.loop.step(30);
      // the first leg is `away` (the pillager at 9, inside FLEE_AWAY); from 13 off the next one is `far`
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: me.x - 13, y: F, z: me.z }));
      const t = performance.now();
      const spy = vi.spyOn(performance, 'now').mockReturnValue(t + 3000); // past the leg's hold
      s.mover.finish({ ok: true });
      s.loop.step(30);
      spy.mockRestore();
      const last = s.mover.gotos.at(-1)!;
      expect(last.goal.type as string).toBe('runAway');
      const r = (last.goal as unknown as { r: number }).r;
      if (on) expect(r).toBeCloseTo(followRunRadius(13), 0);
      else expect(r).toBeLessThanOrEqual(FLEE_FAR);
      s.pve.dispose();
    }
  });
});

describe('a flight that gives up with the archer still in sight (followRun)', () => {
  it('on: the next flight starts at once (no 2 s in which guard chases the pillager with a fist); off: guard takes the body', () => {
    for (const on of [false, true]) {
      const s = controller(20, { x: 0, y: F, z: 0 });
      s.pve.rules.followRun = on;
      const me = { x: 30.5, y: F, z: 0.5 };
      s.loop.pos = me;
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: me.x - 9, y: F, z: me.z }));
      s.pve.setGuard({ on: true, radius: 16 });
      s.loop.step(30);
      expect(s.pve.processes.active?.name).toBe('flee');
      // the pillager 12 off (beyond FLEE_URGENT, inside guard's radius), in sight
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: s.loop.pos.x - 12, y: F, z: s.loop.pos.z }));
      const t = performance.now();
      const spy = vi.spyOn(performance, 'now').mockReturnValue(t + 61_000); // past FLEE_MAX_MS
      s.loop.step(6);
      expect(s.pve.processes.active?.name).toBe(on ? 'flee' : 'guard');
      spy.mockRestore();
      s.pve.dispose();
    }
  });

  it('on: also with the archer just out of sight at that tick (20 behind): no cooldown, the flight again once it is seen; off: the 2 s cooldown', () => {
    for (const on of [false, true]) {
      const s = controller(20, { x: 0, y: F, z: 0 });
      s.pve.rules.followRun = on;
      const me = { x: 30.5, y: F, z: 0.5 };
      s.loop.pos = me;
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: me.x - 9, y: F, z: me.z }));
      s.pve.setGuard({ on: true, radius: 16 });
      s.loop.step(30);
      const flees = s.pve.stats.flees;
      // at the minute's end the pillager is 20 off: beyond bareArcher's 16, within FLEE_SCAN + 8
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: s.loop.pos.x - 20, y: F, z: s.loop.pos.z }));
      const t = performance.now();
      const spy = vi.spyOn(performance, 'now').mockReturnValue(t + 61_000); // past FLEE_MAX_MS
      s.loop.step(3);
      // seen again at 12 within the cooldown's 2 s
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: s.loop.pos.x - 12, y: F, z: s.loop.pos.z }));
      s.loop.step(6);
      expect(s.pve.stats.flees - flees).toBe(on ? 1 : 0);
      expect(s.pve.processes.active?.name === 'flee').toBe(on);
      spy.mockRestore();
      s.pve.dispose();
    }
  });
});

describe('no home leg while an archer follows (followRun)', () => {
  it('on: far legs while the pillager stays within 24, though home is clear and far enough; off: home', () => {
    for (const on of [false, true]) {
      const s = controller(20, { x: 0, y: F, z: 0 });
      s.pve.rules.followRun = on;
      s.loop.pos = { x: 30.5, y: F, z: 0.5 };
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: 39.5, y: F, z: 0.5 }));
      s.pve.setGuard({ on: true, radius: 16 });
      s.loop.step(30);
      expect(s.pve.processes.active?.name).toBe('flee');
      // 50 out from the start (FLEE_FAR), home 20 behind, the pillager 14 off to the side (90 degrees: home is clear)
      s.loop.pos = { x: -19.5, y: F, z: 0.5 };
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: -19.5, y: F, z: 14.5 }));
      const t = performance.now();
      const spy = vi.spyOn(performance, 'now');
      for (const dt of [3000, 6000, 9000]) {
        spy.mockReturnValue(t + dt); // past the leg's hold, and home clear for the hold
        s.mover.finish({ ok: false, reason: 'interrupted' });
        s.loop.step(10);
      }
      spy.mockRestore();
      const homeLegs = s.mover.gotos.filter((g) => (g.goal.type as string) === 'block').length;
      if (on) expect(homeLegs).toBe(0);
      else expect(homeLegs).toBeGreaterThan(0);
      s.pve.dispose();
    }
  });
});

describe('a blade crafted with an archer in sight (craftBlade, tasks/process/blade.ts)', () => {
  const base = { on: true, smith: true, item: true, archer: true, health: 20, melee: false, retry: false, hostiles: 1 };
  it(`bladeNow: on, a smith and an item, an archer in sight, health ${BLADE_CRAFT_HEALTH} or over, no melee mob near, not in the retry wait`, () => {
    expect(bladeNow(base)).toBe(true);
    expect(bladeNow({ ...base, health: BLADE_CRAFT_HEALTH })).toBe(true);
    expect(bladeNow({ ...base, health: BLADE_CRAFT_HEALTH - 0.5 })).toBe(false);
    for (const k of ['on', 'smith', 'item', 'archer'] as const) expect(bladeNow({ ...base, [k]: false })).toBe(false);
    for (const k of ['melee', 'retry'] as const) expect(bladeNow({ ...base, [k]: true })).toBe(false);
    expect(bladeNow({ ...base, hostiles: 2 })).toBe(false); // a lone archer only
    expect(BLADE_ITEMS[0]).toBe('iron_sword');
  });

  it('is off by default; on, the craft takes the body before the flight on foot, and the flight runs once it ends without a blade', async () => {
    expect(PVE_RULES_DEFAULT.craftBlade).toBe(false);
    for (const on of [false, true]) {
      const s = controller(20, { x: 0, y: F, z: 0 });
      s.pve.rules.craftBlade = on;
      let finish: ((r: { ok: boolean; line: string }) => void) | undefined;
      const crafts: string[] = [];
      s.pve.bladeSmith = {
        item: () => 'stone_sword',
        craft: (item) => {
          crafts.push(item);
          return new Promise((r) => (finish = r));
        },
      };
      const me = { x: 30.5, y: F, z: 0.5 };
      s.loop.pos = me;
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: me.x - 9, y: F, z: me.z }));
      s.pve.setGuard({ on: true, radius: 16 });
      s.loop.step(5);
      expect(s.pve.processes.active?.name).toBe(on ? 'blade' : 'flee');
      expect(crafts).toEqual(on ? ['stone_sword'] : []);
      if (on) {
        expect(s.mover.gotos).toHaveLength(0);
        finish!({ ok: false, line: 'no table' }); // failed: no retry for BLADE_RETRY_MS, the flight runs
        await Promise.resolve();
        await Promise.resolve();
        s.loop.step(5);
        expect(s.pve.processes.active?.name).toBe('flee');
        expect(crafts).toHaveLength(1);
      }
      s.pve.dispose();
    }
  });

  it(`below ${BLADE_CRAFT_HEALTH} it does not start: the flight runs`, () => {
    const s = controller(BLADE_CRAFT_HEALTH - 1, { x: 0, y: F, z: 0 });
    s.pve.rules.craftBlade = true;
    s.pve.bladeSmith = { item: () => 'stone_sword', craft: () => new Promise(() => {}) };
    const me = { x: 30.5, y: F, z: 0.5 };
    s.loop.pos = me;
    s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: me.x - 9, y: F, z: me.z }));
    s.pve.setGuard({ on: true, radius: 16 });
    s.loop.step(5);
    expect(s.pve.processes.active?.name).toBe('flee');
    s.pve.dispose();
  });
});

describe('the sprint-jump (follower.ts sprintJumpOk; the flight on foot\'s sprintJump rule)', () => {
  const ok = { sprinting: true, onGround: true, aimLevel: true, dAim: 6, err: 2, runLength: 9, hazard: false, sneak: false, finalLeg: false };
  it('jumps only sprinting on the ground on a straight level run, facing the aim, not at the end, nothing beside the way', () => {
    expect(sprintJumpOk(ok)).toBe(true);
    expect(sprintJumpOk({ ...ok, sprinting: false })).toBe(false);
    expect(sprintJumpOk({ ...ok, onGround: false })).toBe(false);
    expect(sprintJumpOk({ ...ok, aimLevel: false })).toBe(false);
    expect(sprintJumpOk({ ...ok, dAim: SPRINT_JUMP_AIM - 0.1 })).toBe(false);
    expect(sprintJumpOk({ ...ok, err: SPRINT_JUMP_ERR })).toBe(false);
    expect(sprintJumpOk({ ...ok, runLength: 8 })).toBe(false);
    expect(sprintJumpOk({ ...ok, hazard: true })).toBe(false);
    expect(sprintJumpOk({ ...ok, sneak: true })).toBe(false);
    expect(sprintJumpOk({ ...ok, finalLeg: true })).toBe(false);
  });

  it(`is off by default; on, a far leg from a following archer asks for it while the food is over ${SPRINT_JUMP_FOOD}`, () => {
    expect(PVE_RULES_DEFAULT.sprintJump).toBe(false);
    for (const [on, food] of [
      [true, 20],
      [true, SPRINT_JUMP_FOOD],
      [false, 20],
    ] as const) {
      const s = controller(20, { x: 0, y: F, z: 0 });
      s.pve.rules.sprintJump = on;
      s.self.food = food;
      const me = { x: 30.5, y: F, z: 0.5 };
      s.loop.pos = me;
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: me.x - 9, y: F, z: me.z }));
      s.pve.setGuard({ on: true, radius: 16 });
      s.loop.step(30);
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: me.x - 13, y: F, z: me.z }));
      const t = performance.now();
      const spy = vi.spyOn(performance, 'now').mockReturnValue(t + 3000); // past the leg's hold
      s.mover.finish({ ok: true });
      s.loop.step(30);
      spy.mockRestore();
      const far = s.mover.gotoOpts.at(-1);
      expect(far?.sprintJump === true).toBe(on && food > SPRINT_JUMP_FOOD);
      // the first (away) leg never jumps
      expect(s.mover.gotoOpts[0]?.sprintJump).toBeUndefined();
      s.pve.dispose();
    }
  });
});
