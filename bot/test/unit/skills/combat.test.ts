// PvE skill units (PLAN.md task 7.4, docs/pve.md): entity classes, the mob tracker (health, fuse,
// target, hurt/death, attacker guess), weapon choice, the attack packet (serialised with the real
// 1.26.60 serializer), and the CombatController closed loop on fakes: approach with the navigator,
// steer and strike on a 10-tick cadence, creeper evasion, and the hard rule that players are refused.
import { describe, expect, it } from 'vitest';
import { createDeserializer, createSerializer } from '../../../src/connection/protocol.ts';
import { attackTransaction, bestWeaponSlot, CombatController, swingPacket, weaponScore } from '../../../src/skills/combat/combat.ts';
import { classify, entityFeet, facing, MobTracker, normalizeTypeName, reachDistance, typeMatches } from '../../../src/skills/combat/hostiles.ts';
import { yawTowards } from '../../../src/skills/nav/follower.ts';
import { EntityTracker } from '../../../src/world/entities.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import type { EntityInfo, ItemStack } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const sword: ItemV4 = { network_id: 309, count: 1, metadata: 0, has_stack_id: true, stack_id: 1, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } } as unknown as ItemV4;

function setup(entities: Map<bigint, EntityInfo>, slots: (ItemStack | null)[] = [null, null, { name: 'iron_sword', networkId: 309, count: 1, metadata: 0 }]) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const mover = new FakeMover();
  const inv = { slots, selected: 0 };
  const selected: number[] = [];
  const mobs = new MobTracker(src, { entities: () => entities, selfRuntimeId: () => 1n, selfPos: () => loop.state.pos });
  const combat = new CombatController({
    loop,
    mover,
    entities: () => entities,
    mobs,
    inventory: inv,
    hotbar: {
      select: (s) => {
        selected.push(s);
        inv.selected = s;
        return true;
      },
      rawItem: (s) => (s === 2 ? sword : undefined),
    },
    source: src,
    selfRuntimeId: () => 1n,
  });
  const attacks = () => src.sent.filter((p) => p.name === 'inventory_transaction');
  return { src, loop, mover, mobs, combat, selected, attacks, inv };
}

// ---- tests ------------------------------------------------------------------------------------

describe('entity classes', () => {
  it('classifies hostile, neutral, passive, player and item types', () => {
    expect(classify('minecraft:zombie')).toBe('hostile');
    expect(classify('minecraft:zombie_villager_v2')).toBe('hostile');
    expect(classify('creeper')).toBe('hostile');
    expect(classify('minecraft:skeleton')).toBe('hostile');
    expect(classify('minecraft:enderman')).toBe('neutral');
    expect(classify('minecraft:zombie_pigman')).toBe('neutral');
    expect(classify('minecraft:iron_golem')).toBe('neutral');
    expect(classify('minecraft:pig')).toBe('passive');
    expect(classify('minecraft:villager_v2')).toBe('passive');
    expect(classify('minecraft:player')).toBe('player');
    expect(classify('minecraft:item')).toBe('item');
    expect(classify('minecraft:arrow')).toBe('item');
    expect(classify('minecraft:something_new')).toBe('other');
  });

  it('matches typed names to Bedrock ids', () => {
    expect(normalizeTypeName('Zombified Piglin')).toBe('zombie_pigman');
    expect(typeMatches('minecraft:zombie_pigman', 'zombified_piglin')).toBe(true);
    expect(typeMatches('minecraft:villager_v2', 'villager')).toBe(true);
    expect(typeMatches('minecraft:zombie_villager_v2', 'zombie_villager')).toBe(true);
    expect(typeMatches('minecraft:zombie', 'minecraft:zombie')).toBe(true);
    expect(typeMatches('minecraft:husk', 'zombie')).toBe(false);
  });

  it('players are at the eye, mobs at the feet; reach is measured to the box', () => {
    expect(entityFeet(mob(5n, 'minecraft:player', { x: 1, y: -58.38, z: 2 }, { username: 'Steve' })).y).toBeCloseTo(-60);
    expect(entityFeet(mob(6n, 'minecraft:zombie', { x: 1, y: -60, z: 2 })).y).toBe(-60);
    const eye = { x: 0, y: -58.38, z: 0 };
    // zombie 2 blocks ahead: the box face is 1.7 away horizontally
    expect(reachDistance(eye, mob(6n, 'minecraft:zombie', { x: 0, y: -60, z: 2 }))).toBeCloseTo(1.7, 5);
  });

  it('add_player positions are feet on the wire and stored as eye positions', () => {
    const t = new EntityTracker({ toItem: () => ({ name: 'x', networkId: 0, count: 0, metadata: 0 }), selfRuntimeId: () => 1n });
    t.handleAddPlayer({ uuid: 'u', username: 'Steve', runtime_id: 5n, unique_id: -5n, position: { x: 1, y: -60, z: 2 }, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0 });
    expect(t.entities.get(5n)!.pos.y).toBeCloseTo(-58.38);
    t.handleMovePlayer({ runtime_id: 5n, position: { x: 1, y: -58.38, z: 3 }, pitch: 0, yaw: 0, head_yaw: 0, on_ground: true } as never);
    expect(entityFeet(t.entities.get(5n)!).y).toBeCloseTo(-60);
  });

  it('facing uses the head yaw', () => {
    const z = mob(6n, 'minecraft:zombie', { x: 0, y: -60, z: 3 }, { headYaw: 180, yaw: 180 });
    expect(facing(z, { x: 0, y: -60, z: 0 })).toBe(true);
    expect(facing({ ...z, headYaw: 0, yaw: 0 }, { x: 0, y: -60, z: 0 })).toBe(false);
  });
});

describe('MobTracker', () => {
  it('keeps health, fuse, target, hurt and death from packets', () => {
    const src = new FakeSource();
    const ents = new Map<bigint, EntityInfo>();
    const tr = new MobTracker(src, { entities: () => ents, selfRuntimeId: () => 1n, selfPos: () => ({ x: 0, y: -60, z: 0 }) });
    src.emit('start_game', { entity_id: -100n });
    src.emit('add_entity', { runtime_id: 7n, attributes: [{ name: 'minecraft:health', min: 0, value: 20, max: 20 }], metadata: [{ key: 'flags', value: { ignited: false } }, { key: 'target_eid', value: 0n }] });
    expect(tr.get(7n)).toMatchObject({ health: 20, maxHealth: 20, ignited: false, targetUid: undefined, dead: false });
    src.emit('update_attributes', { runtime_entity_id: 7n, attributes: [{ name: 'minecraft:health', current: 13.1, max: 20 }] });
    src.emit('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'target_eid', value: -100n }] });
    src.emit('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { ignited: true } }] });
    src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'hurt_animation', data: 2 });
    expect(tr.get(7n)).toMatchObject({ health: 13.1, ignited: true, hurts: 1, lastHurtData: 2 });
    expect(tr.targetsUs(7n)).toBe(true);
    src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    expect(tr.get(7n)!.dead).toBe(true);
  });

  it('guesses the attacker on an own health drop: the mob targeting us beats a nearer one', () => {
    const src = new FakeSource();
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 1.5 }, { headYaw: 0 })], // near, facing away
      [8n, mob(8n, 'minecraft:skeleton', { x: 0, y: -60, z: 5 }, { headYaw: 180 })],
      [9n, mob(9n, 'minecraft:pig', { x: 0, y: -60, z: 0.5 })],
    ]);
    const tr = new MobTracker(src, { entities: () => ents, selfRuntimeId: () => 1n, selfPos: () => ({ x: 0, y: -60, z: 0 }) });
    src.emit('start_game', { entity_id: -100n });
    src.emit('set_entity_data', { runtime_entity_id: 8n, metadata: [{ key: 'target_eid', value: -100n }] });
    const seen: unknown[] = [];
    tr.onHit((g, d) => seen.push({ rid: g?.runtimeId, why: g?.why, d }));
    src.emit('set_health', { health: 20 });
    src.emit('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: 16 }] });
    expect(seen).toEqual([{ rid: 8n, why: 'target', d: 4 }]);
    expect(tr.lastHitBy).toMatchObject({ runtimeId: 8n, type: 'minecraft:skeleton' });
    // without a target: the facing hostile within 4 blocks
    src.emit('set_entity_data', { runtime_entity_id: 8n, metadata: [{ key: 'target_eid', value: 0n }] });
    ents.get(7n)!.headYaw = 180;
    ents.get(7n)!.yaw = 180;
    src.emit('set_health', { health: 13 });
    expect(tr.lastHitBy).toMatchObject({ runtimeId: 7n, why: 'facing' });
  });
});

describe('weapons and the attack packet', () => {
  it('prefers swords, then axes, then anything', () => {
    expect(weaponScore('iron_sword')).toBeGreaterThan(weaponScore('diamond_axe'));
    expect(weaponScore('diamond_sword')).toBeGreaterThan(weaponScore('iron_sword'));
    expect(weaponScore('stone_axe')).toBeGreaterThan(weaponScore('dirt'));
    const slots: (ItemStack | null)[] = [{ name: 'dirt', networkId: 2, count: 3, metadata: 0 }, { name: 'stone_axe', networkId: 3, count: 1, metadata: 0 }, null, { name: 'wooden_sword', networkId: 4, count: 1, metadata: 0 }];
    expect(bestWeaponSlot(slots, 0)).toBe(3);
    expect(bestWeaponSlot([null, null], 0)).toBeUndefined();
  });

  it('serialises with the 1.26.60 protocol', () => {
    const ser = createSerializer('1.26.60');
    const de = createDeserializer('1.26.60');
    const params = attackTransaction({ target: 14n, hotbarSlot: 2, held: sword, eye: { x: 1.5, y: -58.38, z: 2.5 } });
    const back = de.parsePacketBuffer(ser.createPacketBuffer({ name: 'inventory_transaction', params })) as unknown as { data: { params: { transaction: { transaction_type: string; transaction_data: Record<string, unknown> } } } };
    const t = back.data.params.transaction;
    expect(t.transaction_type).toBe('item_use_on_entity');
    expect(t.transaction_data).toMatchObject({ entity_runtime_id: 14n, action_type: 'attack', hotbar_slot: 2, hand: 'main_hand', held_item: { network_id: 309 } });
    const swing = de.parsePacketBuffer(ser.createPacketBuffer({ name: 'animate', params: swingPacket(1n) })) as { data: { params: Record<string, unknown> } };
    expect(swing.data.params).toMatchObject({ action_id: 'swing_arm', swing_source: 'attack' });
  });
});

describe('CombatController', () => {
  it('approaches with a near goal, then steers, strikes on a 10-tick cadence and reports the kill', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 10 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    expect(s.selected).toEqual([2]); // the iron sword
    s.loop.step();
    expect(s.mover.gotos[0]).toMatchObject({ goal: { type: 'near', r: 2.5 }, sprint: true });
    // the navigator brings us close (simulated by moving the body)
    s.loop.pos = { x: 0, y: -60, z: 7.5 };
    s.loop.step();
    expect(s.mover.nav.busy).toBe(false); // taken over
    expect(s.loop.cmd.yaw).toBeCloseTo(yawTowards(0, 1));
    expect(s.attacks()).toHaveLength(1);
    expect(s.attacks()[0]!.params).toMatchObject({ transaction: { transaction_type: 'item_use_on_entity', transaction_data: { entity_runtime_id: 7n, action_type: 'attack', hotbar_slot: 2 } } });
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'hurt_animation', data: 2 });
    s.loop.step(9);
    expect(s.attacks()).toHaveLength(1);
    s.loop.step(1);
    expect(s.attacks()).toHaveLength(2);
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    s.loop.step();
    const r = await fight;
    expect(r).toMatchObject({ ok: true, reason: 'killed', attacks: 2, landed: 2, weapon: 'iron_sword' });
    expect(s.combat.busy).toBe(false);
  });

  it('refuses players, whatever the caller asks', async () => {
    const ents = new Map<bigint, EntityInfo>([
      [5n, mob(5n, 'minecraft:player', { x: 0, y: -58.38, z: 1.5 }, { username: 'Steve' })],
      [6n, mob(6n, 'minecraft:zombie', { x: 0, y: -60, z: 1.5 }, { username: 'Disguised' })],
    ]);
    const s = setup(ents);
    expect(await s.combat.fight(5n)).toMatchObject({ ok: false, reason: 'refused_player' });
    expect(await s.combat.fight(6n)).toMatchObject({ ok: false, reason: 'refused_player' });
    expect(s.combat.attack(5n)).toBe(false);
    s.loop.step(20);
    expect(s.attacks()).toHaveLength(0);
  });

  it('runs from a creeper with a lit fuse and comes back when it goes out', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:creeper', { x: 0, y: -60, z: 2 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    s.src.emit('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { ignited: true } }] });
    s.loop.step(3);
    expect(s.loop.cmd.forward).toBe(1);
    expect(Math.abs(s.loop.cmd.yaw)).toBeGreaterThan(165); // away from the creeper at +z
    s.loop.step(40);
    expect(s.loop.pos.z).toBeLessThan(-4); // 7 blocks away
    const away = s.loop.pos.z;
    s.loop.step(5);
    expect(s.loop.pos.z).toBeCloseTo(away, 1); // waits
    s.src.emit('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { ignited: false } }] });
    s.loop.step(12);
    expect(s.mover.gotos.length).toBeGreaterThan(0); // approaching again
    ents.delete(7n); // exploded somewhere else / despawned
    s.loop.step();
    expect((await fight).reason).toBe('gone');
  });

  it('ends when the target stays out of range for 100 ticks', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:skeleton', { x: 0, y: -60, z: 40 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n, { maxRange: 32, stallTicks: 0 }); // Track AO: without the stall watchdog (it ends a target that does not come closer first)
    s.loop.step(100);
    expect((await fight).reason).toBe('out_of_range');
  });

  it('defends in place without walking', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:zombie', { x: 3, y: -60, z: 0 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n, { approach: false });
    s.loop.step(1);
    expect(s.attacks()).toHaveLength(0); // 2.7 blocks to the box, but turned only 40 of 90 degrees
    s.loop.step(4);
    expect(s.attacks()).toHaveLength(1);
    expect(s.mover.gotos).toHaveLength(0);
    expect(s.loop.cmd.forward).toBe(0);
    expect(s.loop.pos).toEqual({ x: 0, y: -60, z: 0 });
    s.combat.cancel();
    expect((await fight).reason).toBe('interrupted');
  });
});
