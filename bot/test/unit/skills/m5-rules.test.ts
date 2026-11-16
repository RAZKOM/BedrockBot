// Track M5 (docs/pve.md "Track M5: witches and arrows under poison", ADR 0079 addendum): the guard tests for this track's rules.
import { describe, expect, it, vi } from 'vitest';
import { FOOD_SPRINT_EAT, PveController, PVE_RULES_DEFAULT, segmentDistance, SHOOTER_LOST_FAR, SHOOTER_MEMORY_MS, SHOOTER_WAY, WITCH_CROWD_HEALTH } from '../../../src/tasks/pve.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

function controller(health: number, home: Vec3 | undefined) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const ents = new Map<bigint, EntityInfo>();
  const pve = new PveController({ source: src, world: { entities: ents, inventory: new Inventory(() => null, () => 1n), self: { runtimeId: 1n, health } }, loop, skills: Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) }), home: () => home, shelter: () => undefined, inactive: () => false, options: { guard: { on: true, radius: 16 } } });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health });
  return { src, loop, ents, pve };
}

describe('the way home past the archers (shooterWay)', () => {
  it('is on by default', () => {
    expect(PVE_RULES_DEFAULT.shooterWay).toBe(true);
  });

  it('segmentDistance: to the nearest point of the segment, ends included', () => {
    const a = { x: 0, z: 0 };
    const b = { x: 40, z: 0 };
    expect(segmentDistance({ x: 20, z: 10 }, a, b)).toBeCloseTo(10);
    expect(segmentDistance({ x: -6, z: 8 }, a, b)).toBeCloseTo(10); // behind the start: to the start
    expect(segmentDistance({ x: 46, z: -8 }, a, b)).toBeCloseTo(10); // beyond the end: to the end
    expect(segmentDistance({ x: 3, z: 4 }, a, a)).toBeCloseTo(5); // a point
  });

  it('shooterOnWay: an archer or a witch within the radius of the way, seen or not; not melee mobs, not off to the side, not behind', () => {
    const home = { x: 0, y: -60, z: 0 };
    const s = controller(2, home);
    const me = { x: 40.5, y: -60, z: 0.5 };
    s.ents.set(5n, mob(5n, 'minecraft:zombie', { x: 20, y: -60, z: 2 }));
    expect(s.pve.shooterOnWay(me, home, SHOOTER_WAY)).toBe(false);
    s.ents.set(6n, mob(6n, 'minecraft:skeleton', { x: 20, y: -60, z: 0.5 + SHOOTER_WAY + 2 }));
    expect(s.pve.shooterOnWay(me, home, SHOOTER_WAY)).toBe(false); // 18 off the way
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: 20, y: -60, z: 12 }));
    expect(s.pve.shooterOnWay(me, home, SHOOTER_WAY)).toBe(true); // 11.5 off the middle of the way (home itself is 23 from it)
    expect(s.pve.shooterNear(home, 16)).toBe(false); // so shooterHome alone did not see it
    s.ents.delete(7n);
    s.ents.set(8n, mob(8n, 'minecraft:witch', { x: 50, y: -60, z: 0.5 }));
    expect(s.pve.shooterOnWay(me, home, SHOOTER_WAY)).toBe(false); // behind the bot: the way home runs from her
    s.ents.set(9n, mob(9n, 'minecraft:witch', { x: 36, y: -60, z: -10 }));
    expect(s.pve.shooterOnWay(me, home, SHOOTER_WAY)).toBe(true); // beside the start of the way
    s.pve.dispose();
  });
});

describe('archers out of the server range are remembered (shooterWay)', () => {
  it(`one the server stops sending ${SHOOTER_LOST_FAR} or more off is kept on the way for ${SHOOTER_MEMORY_MS / 1000} s; one lost near is not (a kill)`, () => {
    const home = { x: 0, y: -60, z: 0 };
    const s = controller(2, home);
    s.loop.pos = { x: 50.5, y: -60, z: 0.5 };
    const me = s.loop.pos;
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: -10, y: -60, z: 4 })); // 60 off, beside the way near home
    s.ents.set(8n, mob(8n, 'minecraft:stray', { x: 30, y: -60, z: 41 })); // 45 off (under 48: a kill), 41 from the way
    s.loop.step(10);
    expect(s.pve.rememberedShooters()).toEqual([]); // still sent: not a memory
    s.ents.delete(7n);
    s.ents.delete(8n);
    s.loop.step(10);
    expect(s.pve.rememberedShooters().length).toBe(1);
    expect(s.pve.shooterOnWay(me, home, SHOOTER_WAY)).toBe(true);
    const t = performance.now();
    const spy = vi.spyOn(performance, 'now').mockReturnValue(t + SHOOTER_MEMORY_MS + 1000);
    expect(s.pve.shooterOnWay(me, home, SHOOTER_WAY)).toBe(false); // forgotten
    spy.mockRestore();
    // lost near the bot: killed or gone, not out of range
    s.ents.set(9n, mob(9n, 'minecraft:skeleton', { x: 40, y: -60, z: 2 }));
    s.loop.step(10);
    s.ents.delete(9n);
    s.loop.step(10);
    expect(s.pve.rememberedShooters().some((p) => p.x === 40)).toBe(false);
    s.pve.dispose();
  });
});

describe('the witch with archers shooting (witchCrowd)', () => {
  function armed(health: number) {
    const s = controller(health, { x: 0, y: -60, z: 0 });
    s.pve.settings.set('mobReflex', false);
    s.pve.d.world.inventory.setItem(0, 0, { name: 'stone_sword', networkId: 1, count: 1, metadata: 0 });
    return s;
  }
  it('is on by default', () => {
    expect(PVE_RULES_DEFAULT.witchCrowd).toBe(true);
  });

  it(`at ${WITCH_CROWD_HEALTH} or under with an archer within 16 and a blade under diamond: not the first target; above it, with no archer or with a netherite sword, she is`, () => {
    const s = armed(WITCH_CROWD_HEALTH);
    const me = s.loop.pos;
    s.ents.set(7n, mob(7n, 'minecraft:witch', { x: me.x + 6, y: me.y, z: me.z }));
    const witch = s.ents.get(7n)!;
    expect(s.pve.firstTarget(witch, me)).toBe(true); // no archer: her first, at any health within 8
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: me.x - 10, y: me.y, z: me.z }));
    expect(s.pve.firstTarget(witch, me)).toBe(false);
    s.pve.rules.witchCrowd = false;
    expect(s.pve.firstTarget(witch, me)).toBe(true); // the rule off: the code before
    s.pve.dispose();
    const h = armed(WITCH_CROWD_HEALTH + 1);
    h.ents.set(7n, mob(7n, 'minecraft:witch', { x: h.loop.pos.x + 6, y: h.loop.pos.y, z: h.loop.pos.z }));
    h.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: h.loop.pos.x - 10, y: h.loop.pos.y, z: h.loop.pos.z }));
    expect(h.pve.firstTarget(h.ents.get(7n)!, h.loop.pos)).toBe(true); // above it: her first
    h.pve.dispose();
    const n = armed(WITCH_CROWD_HEALTH);
    n.pve.d.world.inventory.setItem(0, 0, { name: 'netherite_sword', networkId: 2, count: 1, metadata: 0 });
    n.ents.set(7n, mob(7n, 'minecraft:witch', { x: n.loop.pos.x + 6, y: n.loop.pos.y, z: n.loop.pos.z }));
    n.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: n.loop.pos.x - 10, y: n.loop.pos.y, z: n.loop.pos.z }));
    expect(n.pve.firstTarget(n.ents.get(7n)!, n.loop.pos)).toBe(true); // a netherite (or diamond) sword: her first, as before
    n.pve.dispose();
  });
});

describe('no bite under poison with a witch or an archer near (poisonBite)', () => {
  it('is on by default', () => {
    expect(PVE_RULES_DEFAULT.poisonBite).toBe(true);
  });

  it('held only while poisoned, with a witch or an archer within FLEE_SCAN + 8 (seen or not), above FOOD_SPRINT_EAT', () => {
    const s = controller(2, { x: 0, y: -60, z: 0 });
    const me = s.loop.pos;
    s.ents.set(7n, mob(7n, 'minecraft:witch', { x: me.x + 20, y: me.y, z: me.z }));
    expect(s.pve.biteHeld(me)).toBe(false); // not poisoned
    s.pve.mobs.selfPoison = { amplifier: 0, until: performance.now() + 10_000 };
    expect(s.pve.biteHeld(me)).toBe(true);
    s.pve.rules.poisonBite = false;
    expect(s.pve.biteHeld(me)).toBe(false); // the rule off
    s.pve.rules.poisonBite = true;
    s.ents.set(7n, mob(7n, 'minecraft:witch', { x: me.x + 25, y: me.y, z: me.z }));
    expect(s.pve.biteHeld(me)).toBe(false); // 25 off
    s.ents.set(8n, mob(8n, 'minecraft:zombie', { x: me.x + 3, y: me.y, z: me.z }));
    expect(s.pve.biteHeld(me)).toBe(false); // a melee mob does not hold it
    s.ents.set(9n, mob(9n, 'minecraft:skeleton', { x: me.x, y: me.y, z: me.z - 18 }));
    expect(s.pve.biteHeld(me)).toBe(true);
    s.pve.mobs.selfPoison = { amplifier: 0, until: performance.now() - 1 };
    expect(s.pve.biteHeld(me)).toBe(false); // the poison over
    s.pve.dispose();
  });

  it('not with the food down to FOOD_SPRINT_EAT (the sprint is worth the bite)', () => {
    const s = controller(2, { x: 0, y: -60, z: 0 });
    const me = s.loop.pos;
    s.pve.food = () => FOOD_SPRINT_EAT;
    s.pve.mobs.selfPoison = { amplifier: 0, until: performance.now() + 10_000 };
    s.ents.set(7n, mob(7n, 'minecraft:witch', { x: me.x + 12, y: me.y, z: me.z }));
    expect(s.pve.biteHeld(me)).toBe(false);
    s.pve.dispose();
  });
});
