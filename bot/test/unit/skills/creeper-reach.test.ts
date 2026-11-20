// Track E7 (docs/pve.md "A creeper in reach", ADR 0079 decisions 70 and 71, ADR 0104): `creeperReach`, a code switch
// that ships off (the tunnel replica found it better in no cell). With it on and guard off the body leaves a creeper the
// reflex's strikes do not deal with: one in its blast reach whose fuse has burned CREEPER_LIT_BACKOFF ticks, or one
// within CREEPER_BACKOFF_RANGE while the strike in hand is too weak to keep it off. The reflex strikes on as before (its
// strikes are what cut the fuse). On a fresh world a mine step's walk had a creeper on it, the fuse burned out and the
// blast took the bot from 18 to 0.
import { describe, expect, it, vi } from 'vitest';
import { strikeDamage } from '../../../src/skills/combat/combat.ts';
import { MobTracker } from '../../../src/skills/combat/hostiles.ts';
import { reflexPicks } from '../../../src/skills/combat/reflex.ts';
import { CREEPER_BACKOFF_RANGE, CREEPER_BLAST_REACH, CREEPER_LIT_BACKOFF, CREEPER_STRIKES_MAX, creeperStrikesEnough, FLEE_CREEPER_RANGE, PveController, walledIn } from '../../../src/tasks/pve.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const F = -60;
const stack = (name: string, extra: Partial<ItemStack> = {}): ItemStack => ({ name, networkId: 1, count: 1, metadata: 0, ...extra });

describe('strikeDamage: what one strike does', () => {
  it('a fist 1; a weapon its damage + 1 (the measured 5.9 of a stone sword, 9 of a netherite one); a pickaxe less', () => {
    expect(strikeDamage(null)).toBe(1);
    expect(strikeDamage(stack('cobblestone'))).toBe(1);
    expect(strikeDamage(stack('stone_sword'))).toBe(6);
    expect(strikeDamage(stack('netherite_sword'))).toBe(9);
    expect(strikeDamage(stack('stone_pickaxe'))).toBe(4);
    expect(strikeDamage(stack('minecraft:iron_sword'))).toBe(7);
  });

  it('sharpness adds 1.25 a level (Bedrock id 9); other enchantments nothing', () => {
    expect(strikeDamage(stack('iron_sword', { enchants: [{ id: 9, lvl: 2 }] }))).toBe(9.5);
    expect(strikeDamage(stack('iron_sword', { enchants: [{ id: 17, lvl: 3 }] }))).toBe(7);
  });
});

describe('creeperStrikesEnough: the strikes keep a creeper off', () => {
  it(`a full creeper in ${CREEPER_STRIKES_MAX} strikes or fewer: a stone pickaxe (5, the measured case), a stone sword (4), a netherite sword (3) yes; a wooden pickaxe (7), a fist (20) no`, () => {
    expect(creeperStrikesEnough(20, strikeDamage(stack('stone_pickaxe')))).toBe(true);
    expect(creeperStrikesEnough(20, strikeDamage(stack('stone_sword')))).toBe(true);
    expect(creeperStrikesEnough(20, strikeDamage(stack('netherite_sword')))).toBe(true);
    expect(creeperStrikesEnough(20, strikeDamage(stack('wooden_pickaxe')))).toBe(false);
    expect(creeperStrikesEnough(20, strikeDamage(null))).toBe(false);
  });

  it('a hurt creeper needs fewer; unknown or zero health counts as a full 20; no damage never', () => {
    expect(creeperStrikesEnough(5, 1)).toBe(true);
    expect(creeperStrikesEnough(6, 1)).toBe(false);
    expect(creeperStrikesEnough(undefined, 4)).toBe(true);
    expect(creeperStrikesEnough(undefined, 3)).toBe(false);
    expect(creeperStrikesEnough(0, 3)).toBe(false);
    expect(creeperStrikesEnough(20, 0)).toBe(false);
  });
});

describe('MobTracker.ticksLit: how long a fuse has burned', () => {
  it('counts from the tick the ignited flag came on; 0 while unlit, after it went out and for an unknown mob', () => {
    const ents = new Map<bigint, EntityInfo>([[2n, mob(2n, 'minecraft:creeper', { x: 2.5, y: F, z: 0.5 })]]);
    const src = new FakeSource();
    let now = 1000;
    const mobs = new MobTracker(src, { entities: () => ents, selfRuntimeId: () => 1n, selfPos: () => ({ x: 0.5, y: F, z: 0.5 }), now: () => now });
    src.emit('add_entity', { runtime_id: 2n, attributes: [], metadata: [] });
    expect(mobs.ticksLit(2n)).toBe(0);
    src.emit('set_entity_data', { runtime_entity_id: 2n, metadata: [{ key: 'flags', value: { ignited: true } }] });
    expect(mobs.ticksLit(2n)).toBe(0);
    now += 600;
    expect(mobs.ticksLit(2n)).toBe(12);
    src.emit('set_entity_data', { runtime_entity_id: 2n, metadata: [{ key: 'flags', value: { ignited: true } }] }); // sent again: the same fuse
    now += 100;
    expect(mobs.ticksLit(2n)).toBe(14);
    src.emit('set_entity_data', { runtime_entity_id: 2n, metadata: [{ key: 'flags', value: { ignited: false } }] });
    expect(mobs.ticksLit(2n)).toBe(0);
    src.emit('set_entity_data', { runtime_entity_id: 2n, metadata: [{ key: 'flags', value: { ignited: true } }] });
    now += 50;
    expect(mobs.ticksLit(2n)).toBe(1); // a new fuse counts from its own start
    expect(mobs.ticksLit(99n)).toBe(0);
  });
});

describe('the reflex is not changed: a creeper in reach is struck as before', () => {
  it('a creeper and a zombie in reach are both picked', () => {
    const list = [mob(2n, 'minecraft:creeper', { x: 2.5, y: F, z: 0.5 }), mob(3n, 'minecraft:zombie', { x: -1.5, y: F, z: 0.5 })];
    const ents = new Map<bigint, EntityInfo>(list.map((e) => [e.runtimeId, e]));
    const src = new FakeSource();
    const me = { x: 0.5, y: F, z: 0.5 };
    const mobs = new MobTracker(src, { entities: () => ents, selfRuntimeId: () => 1n, selfPos: () => me });
    for (const e of list) src.emit('add_entity', { runtime_id: e.runtimeId, attributes: [], metadata: [] });
    const ids = reflexPicks({ entities: ents.values(), mobs, me, struck: new Map(), tick: 100 }).map((c) => c.e.runtimeId);
    expect(ids).toContain(2n);
    expect(ids).toContain(3n);
  });
});

describe('PveController: the back-off (creeperReach)', () => {
  function setup(held: ItemStack | null, o: { guard?: boolean; health?: number } = {}) {
    const src = new FakeSource();
    const loop = new FakeLoop();
    const ents = new Map<bigint, EntityInfo>();
    const inventory = new Inventory(() => null, () => 1n);
    const me = loop.pos;
    const pve = new PveController({ source: src, world: { entities: ents, inventory, self: { runtimeId: 1n, health: o.health ?? 20 } }, loop, skills: Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) }), home: () => undefined, shelter: () => undefined, inactive: () => false, options: { guard: { on: o.guard ?? false, radius: 16 } } });
    src.emit('start_game', { entity_id: -42n });
    src.emit('set_health', { health: o.health ?? 20 });
    if (held) inventory.setItem(0, 0, held);
    expect(pve.rules.creeperReach).toBe(false); // ships off
    pve.rules.creeperReach = true;
    const at = (dx: number): Vec3 => ({ x: me.x + dx, y: me.y, z: me.z });
    /** The fuse of creeper `rid` as the tracker would report it. */
    const lit = (ticks: number) => vi.spyOn(pve.mobs, 'ticksLit').mockReturnValue(ticks);
    return { pve, ents, me, at, src, lit };
  }

  it('a strike that keeps it off (a stone pickaxe or better) and no fuse burning: no back-off', () => {
    for (const item of ['stone_pickaxe', 'stone_sword', 'netherite_sword']) {
      const s = setup(stack(item));
      s.ents.set(7n, mob(7n, 'minecraft:creeper', s.at(3)));
      expect(s.pve.creeperStrikeWeak(s.ents.get(7n)!), item).toBe(false);
      expect(s.pve.creeperBackOff(s.me), item).toBeUndefined();
      expect(s.pve.fleeReason(s.me), item).toBeUndefined();
      s.pve.dispose();
    }
  });

  it(`a fuse lit ${CREEPER_LIT_BACKOFF} ticks within ${CREEPER_BLAST_REACH}: back off at full health whatever is held (why creeper); a shorter fuse or a farther creeper: not yet`, () => {
    const s = setup(stack('netherite_sword'));
    const c = mob(7n, 'minecraft:creeper', s.at(3));
    s.ents.set(7n, c);
    const spy = s.lit(CREEPER_LIT_BACKOFF - 1);
    expect(s.pve.creeperBackOff(s.me)).toBeUndefined();
    spy.mockReturnValue(CREEPER_LIT_BACKOFF);
    expect(s.pve.creeperBackOff(s.me)?.runtimeId).toBe(7n);
    expect(s.pve.fleeReason(s.me)).toMatchObject({ why: 'creeper' });
    s.pve.dispose();
    const far = setup(stack('netherite_sword'));
    far.ents.set(7n, mob(7n, 'minecraft:creeper', far.at(CREEPER_BLAST_REACH + 0.5)));
    far.lit(20);
    expect(far.pve.creeperBackOff(far.me)).toBeUndefined();
    far.pve.dispose();
  });

  it(`a strike too weak to keep it off (a fist, a block, a wooden pickaxe): back off from an unlit creeper within ${CREEPER_BACKOFF_RANGE}`, () => {
    for (const item of [null, stack('cobblestone'), stack('wooden_pickaxe')]) {
      const s = setup(item);
      s.ents.set(7n, mob(7n, 'minecraft:creeper', s.at(CREEPER_BACKOFF_RANGE + 0.5)));
      expect(s.pve.creeperBackOff(s.me)).toBeUndefined();
      s.ents.get(7n)!.pos = s.at(4.5);
      expect(s.pve.creeperStrikeWeak(s.ents.get(7n)!)).toBe(true);
      expect(s.pve.creeperBackOff(s.me)?.runtimeId).toBe(7n);
      expect(s.pve.fleeReason(s.me)).toMatchObject({ why: 'creeper' });
      s.pve.dispose();
    }
  });

  it('guard on (its own hit and run takes the creeper on) or the rule off (the default): no back-off', () => {
    const g = setup(null, { guard: true });
    g.ents.set(7n, mob(7n, 'minecraft:creeper', g.at(3)));
    g.lit(20);
    expect(g.pve.creeperBackOff(g.me)).toBeUndefined();
    g.pve.dispose();
    const off = setup(null);
    off.pve.rules.creeperReach = false;
    off.ents.set(7n, mob(7n, 'minecraft:creeper', off.at(3)));
    off.lit(20);
    expect(off.pve.creeperBackOff(off.me)).toBeUndefined();
    expect(off.pve.fleeReason(off.me)).toBeUndefined();
    off.pve.dispose();
  });

  it(`once backing off it holds until that creeper is ${FLEE_CREEPER_RANGE} away or gone, the fuse out or not`, () => {
    const s = setup(stack('stone_pickaxe'));
    const c = mob(7n, 'minecraft:creeper', s.at(3));
    s.ents.set(7n, c);
    const spy = s.lit(CREEPER_LIT_BACKOFF);
    expect(s.pve.creeperBackOff(s.me)?.runtimeId).toBe(7n);
    spy.mockReturnValue(0); // the fuse went out as the body left
    c.pos = s.at(6.5);
    expect(s.pve.creeperBackOff(s.me)?.runtimeId).toBe(7n);
    c.pos = s.at(8.5);
    expect(s.pve.creeperBackOff(s.me)).toBeUndefined();
    c.pos = s.at(6.5);
    expect(s.pve.creeperBackOff(s.me)).toBeUndefined(); // a fresh start needs a burning fuse again
    // gone while backing off
    spy.mockReturnValue(CREEPER_LIT_BACKOFF);
    c.pos = s.at(3);
    expect(s.pve.creeperBackOff(s.me)?.runtimeId).toBe(7n);
    s.ents.delete(7n);
    expect(s.pve.creeperBackOff(s.me)).toBeUndefined();
    s.pve.dispose();
  });
});

describe('walledIn', () => {
  const grid = (solidAt: (x: number, y: number, z: number) => boolean) => ({ cls: (x: number, y: number, z: number) => (solidAt(x, y, z) ? { boxes: [{}], top: 1 } : { boxes: [], top: 0 }) }) as never;
  const me = { x: 0.5, y: F, z: 0.5 };

  it('every cell round the feet and the head solid: walled in; one open: not; no grid: not', () => {
    const ring = (x: number, y: number, z: number): boolean => (y === F || y === F + 1) && Math.abs(x) + Math.abs(z) === 1;
    expect(walledIn(me, grid((x, y, z) => ring(x, y, z) || y === F - 1 || (x === 0 && z === 0 && y === F + 2)))).toBe(true);
    expect(walledIn(me, grid((x, y, z) => (ring(x, y, z) && !(x === 1 && y === F + 1)) || y === F - 1))).toBe(false);
    expect(walledIn(me, undefined)).toBe(false);
  });
});
