// Track M6 (docs/pve.md "Track M6", ADR 0079 addendum): the guard tests for this track's rules.
import { describe, expect, it } from 'vitest';
import { FLY_SHOOTER_HEALTH, PveController, PVE_RULES_DEFAULT, VOLLEY_ARROW, VOLLEY_HARMING, VOLLEY_MIN_SHOOTERS, VOLLEY_SHOT_MAX, VOLLEY_WITCH_RANGE, volleyRound } from '../../../src/tasks/pve.ts';
import { Inventory, WINDOW_ARMOR } from '../../../src/world/inventory.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

function controller(health: number, home: Vec3 | undefined) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const ents = new Map<bigint, EntityInfo>();
  const pve = new PveController({ source: src, world: { entities: ents, inventory: new Inventory(() => null, () => 1n), self: { runtimeId: 1n, health } }, loop, skills: Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) }), home: () => home, shelter: () => undefined, inactive: () => false, options: { guard: { on: true, radius: 16 } } });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health });
  pve.settings.set('mobReflex', false);
  return { src, loop, ents, pve };
}

describe('no blade: an archer is run from, not fought (bareArcher)', () => {
  it('is on by default', () => {
    expect(PVE_RULES_DEFAULT.bareArcher).toBe(true);
  });

  it('at full health with no blade an archer within 16 starts the flight; with a blade, a witch, a melee mob or 17 off it does not; the rule off: the code before', () => {
    const s = controller(20, { x: 0, y: -60, z: 0 });
    const me = { x: 20.5, y: -60, z: 0.5 };
    s.loop.pos = me;
    s.ents.set(5n, mob(5n, 'minecraft:zombie', { x: me.x + 5, y: me.y, z: me.z }));
    s.ents.set(6n, mob(6n, 'minecraft:witch', { x: me.x - 9, y: me.y, z: me.z }));
    expect(s.pve.bareArcher(me)).toBeUndefined();
    s.ents.set(7n, mob(7n, 'minecraft:pillager', { x: me.x, y: me.y, z: me.z + 17 }));
    expect(s.pve.bareArcher(me)).toBeUndefined(); // 17 off
    s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: me.x, y: me.y, z: me.z + 9 }));
    expect(s.pve.bareArcher(me)?.runtimeId).toBe(8n);
    const r = s.pve.fleeReason(me);
    expect(r?.why).toBe('low');
    expect(r?.threat.runtimeId).toBe(8n);
    s.pve.rules.bareArcher = false;
    expect(s.pve.bareArcher(me)).toBeUndefined();
    expect(s.pve.fleeReason(me)).toBeUndefined(); // 20 health: nothing ran before
    s.pve.rules.bareArcher = true;
    s.pve.d.world.inventory.setItem(0, 0, { name: 'stone_sword', networkId: 1, count: 1, metadata: 0 });
    expect(s.pve.bareArcher(me)).toBeUndefined(); // a blade: the guard fights it as before
    s.pve.d.world.inventory.setItem(0, 0, { name: 'stone_pickaxe', networkId: 2, count: 1, metadata: 0 });
    expect(s.pve.bareArcher(me)?.runtimeId).toBe(8n); // a pickaxe is no blade (hasBlade)
    s.pve.dispose();
  });

  it(`at ${FLY_SHOOTER_HEALTH} health or over the flight stays on foot (the elytra flee's shooter rule is not moved up); below it the floors choose as before`, () => {
    const s = controller(20, { x: 0, y: -60, z: 0 });
    const me = { x: 20.5, y: -60, z: 0.5 };
    s.loop.pos = me;
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: me.x, y: me.y, z: me.z + 9 }));
    expect(s.pve.fleeReason(me)?.foot).toBe(true);
    s.src.emit('set_health', { health: FLY_SHOOTER_HEALTH - 1 });
    const r = s.pve.fleeReason(me);
    expect(r?.why).toBe('low');
    expect(r?.foot).toBeUndefined();
    s.pve.dispose();
  });

  it('a skeleton the bot cannot see is not run from (a wall between)', () => {
    const s = controller(20, { x: 0, y: -60, z: 0 });
    const me = { x: 0.5, y: -60, z: 0.5 };
    s.loop.pos = me;
    const wall = new Set(['0,-60,4', '0,-59,4', '0,-58,4']);
    const grid = { cls: (x: number, y: number, z: number) => (wall.has(`${x},${y},${z}`) ? { boxes: [{}], top: 1, leaves: false } : { boxes: [], top: 0, leaves: false }), stand: () => undefined };
    (s.pve.mover.nav as unknown as { grid: unknown }).grid = grid;
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: 0.5, y: -60, z: 8.5 }));
    expect(s.pve.bareArcher(me)).toBeUndefined();
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: 6.5, y: -60, z: 6.5 }));
    expect(s.pve.bareArcher(me)?.runtimeId).toBe(7n);
    s.pve.dispose();
  });
});

describe('one round of the shooters in sight (volley)', () => {
  it('is on by default', () => {
    expect(PVE_RULES_DEFAULT.volley).toBe(true);
  });

  it('volleyRound: each shooter at its last hit, else an arrow or her harming', () => {
    expect(volleyRound([])).toBe(0);
    expect(volleyRound([{ kind: 'archer' }, { kind: 'archer' }, { kind: 'witch' }])).toBe(2 * VOLLEY_ARROW + VOLLEY_HARMING);
    expect(volleyRound([{ kind: 'archer', last: 1.5 }, { kind: 'witch', last: 4 }])).toBe(5.5);
  });

  it(`flees at fleeHealth or over when the health is at most one round of ${VOLLEY_MIN_SHOOTERS} or more shooters; not one archer, not above the round, not with the rule off`, () => {
    const s = controller(12, { x: 0, y: -60, z: 0 });
    s.pve.d.world.inventory.setItem(0, 0, { name: 'stone_sword', networkId: 1, count: 1, metadata: 0 });
    const me = { x: 20.5, y: -60, z: 0.5 }; // away from home (at home a flight is for a threat within 6 or an archer in sight)
    s.loop.pos = me;
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: me.x + 10, y: me.y, z: me.z }));
    expect(s.pve.volleyNow(me)).toEqual({ shooters: 1, damage: VOLLEY_ARROW });
    expect(s.pve.volleyLow(me)).toBe(false); // one archer: the duel's rules
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: me.x - 9, y: me.y, z: me.z + 4 }));
    s.ents.set(9n, mob(9n, 'minecraft:stray', { x: me.x, y: me.y, z: me.z + 14 }));
    expect(s.pve.volleyNow(me).damage).toBe(3 * VOLLEY_ARROW);
    expect(s.pve.volleyLow(me)).toBe(true); // 12 <= 12
    expect(s.pve.fleeReason(me)?.why).toBe('low');
    s.pve.rules.volley = false;
    expect(s.pve.volleyLow(me)).toBe(false);
    expect(s.pve.fleeReason(me)).toBeUndefined(); // the rule off: the code before (12 is over fleeHealth 8)
    s.pve.rules.volley = true;
    // a witch counts within VOLLEY_WITCH_RANGE only
    s.ents.set(10n, mob(10n, 'minecraft:witch', { x: me.x + VOLLEY_WITCH_RANGE + 2, y: me.y, z: me.z }));
    expect(s.pve.volleyNow(me).shooters).toBe(3);
    s.ents.set(10n, mob(10n, 'minecraft:witch', { x: me.x + VOLLEY_WITCH_RANGE - 2, y: me.y, z: me.z }));
    expect(s.pve.volleyNow(me).damage).toBe(3 * VOLLEY_ARROW + VOLLEY_HARMING);
    // melee mobs are not shooters
    s.ents.set(11n, mob(11n, 'minecraft:zombie', { x: me.x + 3, y: me.y, z: me.z }));
    expect(s.pve.volleyNow(me).shooters).toBe(4);
    s.pve.dispose();
  });

  it('an archer that has not hit yet counts less through the armour worn (4 % a point); her harming does not', () => {
    expect(volleyRound([{ kind: 'archer' }], 20)).toBeCloseTo(VOLLEY_ARROW * 0.2, 5);
    expect(volleyRound([{ kind: 'archer' }, { kind: 'witch' }], 15)).toBeCloseTo(VOLLEY_ARROW * 0.4 + VOLLEY_HARMING, 5);
    expect(volleyRound([{ kind: 'archer', last: 3 }], 20)).toBe(3); // a hit seen is what it did
    const s = controller(16, { x: 0, y: -60, z: 0 });
    const me = { x: 20.5, y: -60, z: 0.5 };
    s.loop.pos = me;
    s.pve.d.world.inventory.setItem(0, 0, { name: 'netherite_sword', networkId: 1, count: 1, metadata: 0 });
    for (const [x, z] of [[10, 0], [-10, 0], [0, 10], [0, -10]] as const) s.ents.set(BigInt(100 + x + z * 3), mob(BigInt(100 + x + z * 3), 'minecraft:skeleton', { x: me.x + x, y: me.y, z: me.z + z }));
    expect(s.pve.volleyNow(me).damage).toBe(4 * VOLLEY_ARROW);
    expect(s.pve.volleyLow(me)).toBe(true); // 16 <= 16 with no armour
    const set = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'];
    set.forEach((name, i) => s.pve.d.world.inventory.setItem(WINDOW_ARMOR, i, { name, networkId: 10 + i, count: 1, metadata: 0 }));
    expect(s.pve.armourPoints()).toBe(20);
    expect(s.pve.volleyNow(me).damage).toBeCloseTo(4 * VOLLEY_ARROW * 0.2, 5);
    expect(s.pve.volleyLow(me)).toBe(false); // the netherite set: four skeletons that have not hit are 3.2
    s.pve.dispose();
  });

  it('counts each archer at what its last hit did (armour: a round under the health is no flight)', () => {
    const s = controller(11.5, { x: 0, y: -60, z: 0 });
    const me = { x: 20.5, y: -60, z: 0.5 };
    s.loop.pos = me;
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: me.x + 10, y: me.y, z: me.z }));
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: me.x - 10, y: me.y, z: me.z }));
    expect(s.pve.volleyNow(me).damage).toBe(2 * VOLLEY_ARROW); // no hit yet: the defaults
    // an arrow through armour: 1.5 (the hit guess blames a ranged mob within 20)
    s.src.emit('set_health', { health: 10 });
    const v = s.pve.volleyNow(me);
    expect(v.shooters).toBe(2);
    expect(v.damage).toBeCloseTo(3, 5); // one at 1.5 (itself, and its type for the other)
    expect(s.pve.volleyLow(me)).toBe(false); // 10 is over a round of 1.5 + 1.5: the netherite set fights on as before
    s.pve.dispose();
  });

  it(`a drop blamed on an archer counts at most ${VOLLEY_SHOT_MAX} (a blast or two hits in one health packet)`, () => {
    const s = controller(20, { x: 0, y: -60, z: 0 });
    const me = { x: 20.5, y: -60, z: 0.5 };
    s.loop.pos = me;
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: me.x + 10, y: me.y, z: me.z }));
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: me.x - 10, y: me.y, z: me.z }));
    s.src.emit('set_health', { health: 11 }); // 9 at once
    expect(s.pve.volleyNow(me).damage).toBe(2 * VOLLEY_SHOT_MAX);
    s.pve.dispose();
  });

  it('below fleeHealth it leaves the flight to the ordinary rule', () => {
    const s = controller(7, { x: 0, y: -60, z: 0 });
    const me = { x: 20.5, y: -60, z: 0.5 };
    s.loop.pos = me;
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: me.x + 10, y: me.y, z: me.z }));
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: me.x - 10, y: me.y, z: me.z }));
    expect(s.pve.volleyLow(me)).toBe(false);
    expect(s.pve.low()).toBe(true);
    s.pve.dispose();
  });
});
