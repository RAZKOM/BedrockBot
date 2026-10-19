// Entities (PLAN.md task 2.4) and inventory (2.5) on synthetic packets.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import { World } from '../../../src/world/index.ts';
import { byteToDegrees } from '../../../src/world/entities.ts';
import { recordedLogin, ReplaySource } from './helpers.ts';

function setup() {
  const src = new ReplaySource();
  const world = new World(src, { logger: silentLogger, defer: (fn) => fn() });
  const { startGame, itemRegistry } = recordedLogin();
  src.emit('start_game', startGame);
  src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
  return { src, world, self: BigInt(startGame.runtime_entity_id) };
}

const item = (network_id: number, count: number) => ({ network_id, count, metadata: 0, has_stack_id: false, block_runtime_id: 0 });

describe('EntityTracker via World', () => {
  it('adds players, mobs and items; removes by unique id and on pickup', () => {
    const { src, world } = setup();
    src.emit('add_player', { uuid: 'u', username: 'Steve', runtime_id: 5n, unique_id: -5n, position: { x: 1, y: -58.38, z: 2 }, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 90, head_yaw: 90 });
    src.emit('add_entity', { unique_id: -6n, runtime_id: 6n, entity_type: 'minecraft:cow', position: { x: 3, y: -60, z: 4 }, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0 });
    const oak = world.registry.itemId('oak_log')!;
    src.emit('add_item_entity', { entity_id_self: -7n, runtime_entity_id: 7n, item: item(oak, 3), position: { x: 6.5, y: -59.875, z: 6.5 }, velocity: { x: 0, y: 0.2, z: 0 } });
    expect(world.entities.size).toBe(3);
    expect(world.entities.get(5n)).toMatchObject({ type: 'minecraft:player', username: 'Steve', yaw: 90 });
    expect(world.entities.get(7n)).toMatchObject({ type: 'minecraft:item', item: { name: 'oak_log', count: 3 } });
    src.emit('remove_entity', { entity_id_self: -6n });
    expect(world.entities.has(6n)).toBe(false);
    src.emit('take_item_entity', { runtime_entity_id: 7n, target: 1n });
    expect(world.entities.has(7n)).toBe(false);
    src.emit('remove_entity', { entity_id_self: -999n }); // unknown: ignored
    expect(world.entities.size).toBe(1);
  });

  it('applies move_entity_delta in the 1.26.40+ optional form and the legacy flag form', () => {
    const { src, world } = setup();
    src.emit('add_entity', { unique_id: -6n, runtime_id: 6n, entity_type: 'minecraft:cow', position: { x: 3, y: -60, z: 4 }, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0 });
    // New form: only z and rot_y present.
    src.emit('move_entity_delta', { runtime_entity_id: 6n, z: 4.5, rot_y: 64, on_ground: true, force_move: false, force_move_local_entity: false, force_completion: false, ticks: 1n });
    expect(world.entities.get(6n)).toMatchObject({ pos: { x: 3, y: -60, z: 4.5 }, yaw: 90, onGround: true });
    // Legacy form: flags say which fields are meaningful (x given but has_x not set: ignored).
    src.emit('move_entity_delta', { runtime_entity_id: 6n, flags: { has_y: true, has_rot_x: true }, x: 100, y: -59, rot_x: 128 });
    expect(world.entities.get(6n)).toMatchObject({ pos: { x: 3, y: -59, z: 4.5 }, pitch: 180, onGround: false });
    src.emit('move_entity_delta', { runtime_entity_id: 6n, flags: 0x01 | 0x40, x: 8 });
    expect(world.entities.get(6n)).toMatchObject({ pos: { x: 8 }, onGround: true });
    expect(byteToDegrees(192)).toBe(270);
  });

  it('applies set_entity_motion, move_entity and move_player for others; own move_player updates self', () => {
    const { src, world, self } = setup();
    src.emit('add_player', { uuid: 'u', username: 'Alex', runtime_id: 9n, unique_id: -9n, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0 });
    src.emit('move_player', { runtime_id: 9, position: { x: 10, y: -58.38, z: 3 }, pitch: 5, yaw: 45, head_yaw: 45, mode: 'normal', on_ground: true, ridden_runtime_id: 0, tick: 0n });
    expect(world.entities.get(9n)).toMatchObject({ pos: { x: 10, y: -58.38, z: 3 }, yaw: 45, onGround: true });
    src.emit('set_entity_motion', { runtime_entity_id: 9n, velocity: { x: 0.1, y: 0, z: 0 }, tick: 0n });
    expect(world.entities.get(9n)?.vel.x).toBe(0.1);
    src.emit('move_player', { runtime_id: Number(self), position: { x: 2, y: -58.38, z: 2 }, pitch: 0, yaw: 180, head_yaw: 180, mode: 'teleport', on_ground: true, ridden_runtime_id: 0, tick: 0n });
    expect(world.self.pos.x).toBe(2);
    expect(world.self.pos.y).toBeCloseTo(-60, 5);
    expect(world.self.yaw).toBe(180);
    src.emit('set_entity_motion', { runtime_entity_id: self, velocity: { x: 0, y: 0.42, z: 0 }, tick: 0n });
    expect(world.self.vel.y).toBe(0.42);
  });

  it('reports corrections in feet coordinates and tracks health, food and game mode', () => {
    const { src, world, self } = setup();
    const seen: unknown[] = [];
    world.onCorrection((c) => seen.push(c));
    src.emit('correct_player_move_prediction', { prediction_type: 'player', position: { x: 1, y: -58.38, z: 1 }, delta: { x: 0, y: -0.08, z: 0 }, rotation: { x: 0, y: 0 }, on_ground: true, tick: 42n });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ onGround: true, tick: 42n, delta: { y: -0.08 } });
    expect(world.self.pos.y).toBeCloseTo(-60, 5);
    src.emit('correct_player_move_prediction', { prediction_type: 'vehicle', position: { x: 9, y: 9, z: 9 }, delta: { x: 0, y: 0, z: 0 }, on_ground: false, tick: 43n });
    expect(seen).toHaveLength(1);
    src.emit('set_health', { health: 15 });
    expect(world.self.health).toBe(15);
    src.emit('update_attributes', { runtime_entity_id: self, attributes: [{ name: 'minecraft:player.hunger', current: 17 }, { name: 'minecraft:health', current: 14 }], tick: 0n });
    expect(world.self).toMatchObject({ food: 17, health: 14 });
    src.emit('update_attributes', { runtime_entity_id: 12345n, attributes: [{ name: 'minecraft:health', current: 1 }], tick: 0n });
    expect(world.self.health).toBe(14);
    src.emit('set_player_game_type', { gamemode: 'creative' });
    expect(world.self.gameMode).toBe('creative');
  });
});

describe('Inventory via World', () => {
  it('tracks inventory_content, inventory_slot, server inventory_transaction, hotbar and own mob_equipment', () => {
    const { src, world, self } = setup();
    const oak = world.registry.itemId('oak_log')!;
    const stone = world.registry.itemId('stone')!;
    const content = new Array(36).fill(0).map(() => item(0, 0));
    content[0] = item(oak, 5);
    src.emit('inventory_content', { window_id: 'inventory', input: content, container: { container_id: 'anvil_input' }, storage_item: item(0, 0) });
    src.emit('inventory_content', { window_id: 'armor', input: [item(0, 0), item(0, 0), item(0, 0), item(0, 0)], container: { container_id: 'anvil_input' }, storage_item: item(0, 0) });
    expect(world.inventory.slots).toHaveLength(36);
    expect(world.inventory.slots[0]).toMatchObject({ name: 'oak_log', count: 5 });
    expect(world.inventory.count('minecraft:oak_log')).toBe(5);
    expect(world.window(120)?.slots).toEqual([null, null, null, null]);
    src.emit('inventory_slot', { window_id: 'inventory', slot: 3, item: item(stone, 64) });
    expect(world.inventory.slots[3]).toMatchObject({ name: 'stone', count: 64 });
    src.emit('inventory_slot', { window_id: 'offhand', slot: 0, item: item(stone, 1) });
    expect(world.window(119)?.slots[0]?.name).toBe('stone');
    // How BDS announces /give (and truth:give): a clientbound 'normal' transaction.
    src.emit('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: 'normal',
        actions: [
          { source_type: 'container', window_id: 0, slot: 1, old_item: item(0, 0), new_item: item(oak, 2) },
          { source_type: 'creative', slot: 1, old_item: item(oak, 2), new_item: item(0, 0) },
        ],
      },
    });
    expect(world.inventory.count('oak_log')).toBe(7);
    src.emit('player_hotbar', { selected_slot: 3, window_id: 'inventory', select_slot: true });
    expect(world.inventory.selected).toBe(3);
    expect(world.inventory.held?.name).toBe('stone');
    src.emit('mob_equipment', { runtime_entity_id: 777n, item: item(0, 0), slot: 5, selected_slot: 5, window_id: 'inventory' });
    expect(world.inventory.selected).toBe(3); // someone else's
    src.emit('mob_equipment', { runtime_entity_id: self, item: item(oak, 2), slot: 1, selected_slot: 1, window_id: 'inventory' });
    expect(world.inventory.selected).toBe(1);
    expect(world.window(55)).toBeUndefined();
  });
});
