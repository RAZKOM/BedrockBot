// Track M7 (docs/pve.md "Track M7", ADR 0079 addendum): the live kit's margin. The rush on a witch (FightOptions.rush,
// PveController.witchRushes) and the guard tests for this track's rules.
import { describe, expect, it } from 'vitest';
import { CombatController, RUSH_CREEPER_NEAR } from '../../../src/skills/combat/combat.ts';
import { MobTracker } from '../../../src/skills/combat/hostiles.ts';
import { PveController, PVE_RULES_DEFAULT } from '../../../src/tasks/pve.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const sword: ItemStack = { name: 'netherite_sword', networkId: 316, count: 1, metadata: 0, stackId: 9 };
const shieldItem: ItemStack = { name: 'shield', networkId: 358, count: 1, metadata: 0, stackId: 12 };

/** An inventory with windows 0 and 119 (the offhand), like world/inventory.ts. */
class FakeInventory {
  selected = 0;
  readonly windows = new Map<number, (ItemStack | null)[]>();
  constructor(slots: (ItemStack | null)[]) {
    this.windows.set(0, slots);
    this.windows.set(119, [null]);
  }
  get slots(): (ItemStack | null)[] {
    return this.windows.get(0)!;
  }
  window(id: number): { slots: (ItemStack | null)[] } | undefined {
    const s = this.windows.get(id);
    return s ? { slots: s } : undefined;
  }
  setItem(w: number, slot: number, item: ItemStack | null): void {
    this.windows.get(w)![slot] = item;
  }
}

function fightSetup(entities: Map<bigint, EntityInfo>, opts: { shield?: boolean } = {}) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const mover = new FakeMover();
  const inv = new FakeInventory(Array.from({ length: 36 }, (_, i) => (i === 0 ? sword : null)));
  if (opts.shield) inv.setItem(119, 0, shieldItem);
  const mobs = new MobTracker(src, { entities: () => entities, selfRuntimeId: () => 1n, selfPos: () => loop.state.pos });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health: 20 });
  const combat = new CombatController({
    loop,
    mover,
    entities: () => entities,
    mobs,
    inventory: inv,
    hotbar: {
      select: (s) => {
        inv.selected = s;
        return true;
      },
      rawItem: () => undefined,
    },
    source: src,
    selfRuntimeId: () => 1n,
    containers: () => undefined,
  });
  const attacks = () => src.sent.filter((p) => p.name === 'inventory_transaction').map((p) => (p.params.transaction as { transaction_data: { entity_runtime_id: bigint } }).transaction_data.entity_runtime_id);
  return { src, loop, mover, mobs, combat, attacks, inv };
}

describe('the rush on a witch (FightOptions.rush)', () => {
  it('the shield stays down while a skeleton is due to shoot; without the rush it goes up (a sneak)', async () => {
    for (const rush of [false, true]) {
      const ents = new Map<bigint, EntityInfo>([
        [7n, mob(7n, 'minecraft:witch', { x: 0, y: -60, z: 9 })],
        [8n, mob(8n, 'minecraft:skeleton', { x: 6, y: -60, z: 6 })],
      ]);
      const s = fightSetup(ents, { shield: true });
      s.src.emit('set_entity_data', { runtime_entity_id: 8n, metadata: [{ key: 'target_eid', value: -42n }] });
      const fight = s.combat.fight(7n, { stallTicks: 0, rush });
      let sneaks = 0;
      for (let i = 0; i < 75; i++) {
        s.loop.step(1);
        s.loop.pos = { x: 0, y: -60, z: 0 };
        if (s.loop.cmd.sneak) sneaks++;
      }
      s.combat.cancel();
      const r = await fight;
      if (rush) {
        expect(sneaks).toBe(0);
        expect(r.shieldTicks).toBe(0);
        expect(r.rushTicks).toBeGreaterThan(70);
      } else {
        expect(sneaks).toBeGreaterThan(10); // the predicted shot (about 62 ticks)
        expect(r.rushTicks).toBeUndefined();
      }
    }
  });

  it('the approach sprints from 6 blocks (without the rush only beyond 8 or against an archer)', async () => {
    for (const rush of [false, true]) {
      const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:witch', { x: 0, y: -60, z: 6 })]]);
      const s = fightSetup(ents);
      const fight = s.combat.fight(7n, { stallTicks: 0, rush });
      s.loop.step(1);
      s.loop.pos = { x: 0, y: -60, z: 0 };
      expect(s.mover.gotos.at(-1)?.sprint).toBe(rush);
      s.combat.cancel();
      await fight;
    }
  });

  it('close in, out of reach: the steering sprints; in reach it does not (a sprint strike knocks her farther)', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:witch', { x: 0, y: -60, z: 3.4 })]]);
    const s = fightSetup(ents);
    const fight = s.combat.fight(7n, { stallTicks: 0, rush: true, reach: 2.5 });
    s.loop.step(1);
    expect(s.loop.cmd).toMatchObject({ forward: 1, sprint: true });
    s.loop.pos = { x: 0, y: -60, z: 1 };
    s.loop.step(1);
    expect(s.loop.cmd.sprint).toBe(false);
    s.combat.cancel();
    await fight;
  });

  it(`a creeper within 6 is not fought in between unless lit or within ${RUSH_CREEPER_NEAR}; without the rush it is at once`, async () => {
    for (const rush of [false, true]) {
      const ents = new Map<bigint, EntityInfo>([
        [7n, mob(7n, 'minecraft:witch', { x: 0, y: -60, z: 6 })],
        [9n, mob(9n, 'minecraft:creeper', { x: 5, y: -60, z: 0 })],
      ]);
      const s = fightSetup(ents);
      const fight = s.combat.fight(7n, { stallTicks: 0, rush });
      s.loop.step(1);
      s.loop.pos = { x: 0, y: -60, z: 0 };
      expect(s.combat.target?.runtimeId).toBe(rush ? 7n : 9n);
      if (rush) {
        // lit: fought in between at once
        s.src.emit('set_entity_data', { runtime_entity_id: 9n, metadata: [{ key: 'flags', value: { ignited: true } }] });
        s.loop.step(1);
        expect(s.combat.target?.runtimeId).toBe(9n);
      }
      s.combat.cancel();
      await fight;
    }
    // within RUSH_CREEPER_NEAR, not lit: fought in between
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:witch', { x: 0, y: -60, z: 6 })],
      [9n, mob(9n, 'minecraft:creeper', { x: RUSH_CREEPER_NEAR - 0.3, y: -60, z: 0 })],
    ]);
    const s = fightSetup(ents);
    const fight = s.combat.fight(7n, { stallTicks: 0, rush: true });
    s.loop.step(1);
    expect(s.combat.target?.runtimeId).toBe(9n);
    s.combat.cancel();
    await fight;
  });

  it('no re-pick to a zombie in reach while she is out of reach (the reflex strikes it); without the rush the fight switches', async () => {
    for (const rush of [false, true]) {
      const ents = new Map<bigint, EntityInfo>([
        [7n, mob(7n, 'minecraft:witch', { x: 0, y: -60, z: 6 })],
        [8n, mob(8n, 'minecraft:zombie', { x: 2, y: -60, z: 0 })],
      ]);
      const s = fightSetup(ents);
      const fight = s.combat.fight(7n, { stallTicks: 0, rush });
      for (let i = 0; i < 12; i++) {
        s.loop.step(1);
        s.loop.pos = { x: 0, y: -60, z: 0 };
      }
      expect(s.combat.target?.runtimeId).toBe(rush ? 7n : 8n);
      s.combat.cancel();
      expect((await fight).retargets).toBe(rush ? 0 : 1);
    }
  });

  it('once she is dead the fight goes on as before (the next mob in reach, no rush)', async () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:witch', { x: 0, y: -60, z: 2 })],
      [8n, mob(8n, 'minecraft:zombie', { x: -2, y: -60, z: 1 })],
    ]);
    const s = fightSetup(ents);
    const fight = s.combat.fight(7n, { stallTicks: 0, rush: true });
    s.loop.step(1);
    expect(s.attacks()).toEqual([7n]);
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    s.loop.step(2);
    expect(s.combat.target?.runtimeId).toBe(8n);
    s.combat.cancel();
    const r = await fight;
    expect(r.kills).toBe(1);
  });
});

function controller(health: number) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const ents = new Map<bigint, EntityInfo>();
  const home: Vec3 = { x: 0, y: -60, z: 0 };
  const pve = new PveController({ source: src, world: { entities: ents, inventory: new Inventory(() => null, () => 1n), self: { runtimeId: 1n, health } }, loop, skills: Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) }), home: () => home, shelter: () => undefined, inactive: () => false, options: { guard: { on: true, radius: 16 } } });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health });
  return { src, loop, ents, pve };
}

describe('guard rushes a witch it fights first (witchRush)', () => {
  it('is on by default', () => {
    expect(PVE_RULES_DEFAULT.witchRush).toBe(true);
  });

  it('with a netherite or diamond sword and the reflex on; not with an iron sword, the reflex off, the rule off, or another mob', () => {
    const s = controller(20);
    const me = { x: 0.5, y: -60, z: 0.5 };
    s.loop.pos = me;
    const w = mob(6n, 'minecraft:witch', { x: 6.5, y: -60, z: 0.5 });
    const z = mob(5n, 'minecraft:zombie', { x: -3.5, y: -60, z: 0.5 });
    s.ents.set(6n, w);
    s.ents.set(5n, z);
    s.pve.settings.set('mobReflex', true);
    s.pve.d.world.inventory.setItem(0, 0, { name: 'netherite_sword', networkId: 1, count: 1, metadata: 0 });
    expect(s.pve.witchRushes(w, me)).toBe(true);
    expect(s.pve.witchRushes(z, me)).toBe(false);
    s.pve.d.world.inventory.setItem(0, 0, { name: 'diamond_sword', networkId: 2, count: 1, metadata: 0 });
    expect(s.pve.witchRushes(w, me)).toBe(true);
    s.pve.d.world.inventory.setItem(0, 0, { name: 'iron_sword', networkId: 3, count: 1, metadata: 0 });
    expect(s.pve.witchRushes(w, me)).toBe(false); // five hits or more: Track M5's witchCrowd rows
    s.pve.d.world.inventory.setItem(0, 0, { name: 'netherite_sword', networkId: 1, count: 1, metadata: 0 });
    s.pve.settings.set('mobReflex', false);
    expect(s.pve.witchRushes(w, me)).toBe(false); // nothing strikes the mobs in reach the fight leaves alone
    s.pve.settings.set('mobReflex', true);
    s.pve.rules.witchRush = false;
    expect(s.pve.witchRushes(w, me)).toBe(false);
    s.pve.rules.witchRush = true;
    // not a first target: 13 off (WITCH_FIRST_RANGE 12)
    w.pos = { x: 13.5, y: -60, z: 0.5 };
    expect(s.pve.witchRushes(w, me)).toBe(false);
    s.pve.dispose();
  });

  it('while her path probe runs, guard starts no fight on a zombie in reach (the reflex strikes it); with the rule off it does', () => {
    const s = controller(20);
    const me = { x: 0.5, y: -60, z: 0.5 };
    s.loop.pos = me;
    s.ents.set(6n, mob(6n, 'minecraft:witch', { x: 7.5, y: -60, z: 0.5 }));
    s.ents.set(5n, mob(5n, 'minecraft:zombie', { x: -1.5, y: -60, z: 0.5 }));
    s.pve.settings.set('mobReflex', true);
    s.pve.d.world.inventory.setItem(0, 0, { name: 'netherite_sword', networkId: 1, count: 1, metadata: 0 });
    let verdict: 'pending' | 'none' = 'pending';
    (s.pve.pathReach as unknown as { lookup: () => unknown }).lookup = () => verdict;
    expect(s.pve.pickThreat(me, false)).toBeUndefined();
    s.pve.rules.witchRush = false;
    expect(s.pve.pickThreat(me, false)?.e.runtimeId).toBe(5n); // the code before: the zombie in reach meanwhile
    s.pve.rules.witchRush = true;
    verdict = 'none';
    expect(s.pve.pickThreat(me, false)?.e.runtimeId).toBe(6n);
    s.pve.dispose();
  });
});

describe('milk against the poison (milkCure)', () => {
  function cureSetup(health: number, poisonS: number) {
    const s = controller(health);
    const me = { x: 0.5, y: -60, z: 0.5 };
    s.loop.pos = me;
    s.pve.mobs.selfPoison = { amplifier: 0, until: performance.now() + poisonS * 1000 };
    s.pve.d.world.inventory.setItem(0, 0, { name: 'netherite_sword', networkId: 1, count: 1, metadata: 0 });
    s.pve.d.world.inventory.setItem(0, 5, { name: 'milk_bucket', networkId: 9, count: 1, metadata: 0 });
    const drinks: string[] = [];
    let resolve: ((r: { ok: boolean }) => void) | undefined;
    s.pve.kit = () => ({
      eat: () => Promise.resolve({ ok: false }),
      drink: (name: string) => {
        drinks.push(name);
        return new Promise((r) => (resolve = r));
      },
      equip: () => Promise.resolve({ ok: true, equipped: [] }),
      armour: { worn: () => [], plan: () => [] },
      overrides: {},
    });
    return { ...s, me, drinks, done: (ok: boolean) => resolve?.({ ok }) };
  }

  it('is on by default', () => {
    expect(PVE_RULES_DEFAULT.milkCure).toBe(true);
  });

  it('drinks once the poison would still take more than 3, with no witch within 16 and no mob within 8; once', async () => {
    const s = cureSetup(18, 30); // 30 s of poison: 24 more ticks of 1
    expect(s.pve.wantsCure(s.me)).toBe(true);
    s.loop.step(10);
    expect(s.drinks).toEqual(['milk_bucket']);
    s.loop.step(10);
    expect(s.drinks).toHaveLength(1); // a drink under way: not again
    s.done(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.pve.cures).toBe(1);
    expect(s.pve.mobs.selfPoison).toBeUndefined();
    s.pve.dispose();
  });

  it('not with 3 or less to lose, a witch within 16, a mob within 8, no milk, or the rule off', () => {
    const s = cureSetup(18, 2); // 2 s: 2 more ticks
    expect(s.pve.wantsCure(s.me)).toBe(false);
    s.pve.mobs.selfPoison = { amplifier: 0, until: performance.now() + 30_000 };
    expect(s.pve.wantsCure(s.me)).toBe(true);
    s.ents.set(6n, mob(6n, 'minecraft:witch', { x: 14.5, y: -60, z: 0.5 }));
    expect(s.pve.wantsCure(s.me)).toBe(false); // she throws poison again at a bot that is not poisoned
    s.ents.delete(6n);
    s.ents.set(5n, mob(5n, 'minecraft:zombie', { x: 6.5, y: -60, z: 0.5 }));
    expect(s.pve.wantsCure(s.me)).toBe(false);
    s.ents.delete(5n);
    s.pve.rules.milkCure = false;
    expect(s.pve.wantsCure(s.me)).toBe(false);
    s.pve.rules.milkCure = true;
    s.pve.d.world.inventory.setItem(0, 5, null);
    expect(s.pve.wantsCure(s.me)).toBe(false);
    s.pve.dispose();
  });

  it('at 2 health nothing is left to lose (the poison stops at 1): no drink', () => {
    const s = cureSetup(2, 30);
    expect(s.pve.wantsCure(s.me)).toBe(false);
    s.pve.dispose();
  });
});
