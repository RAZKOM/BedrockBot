// Hotbar slot selection (world/hotbar.ts, PLAN.md 4.2): mob_equipment carries the raw wire item of
// the slot, as seen in inventory_content / inventory_slot / clientbound inventory_transaction.
import { describe, expect, it } from 'vitest';
import { Hotbar, Inventory } from '../../../src/world/index.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';

const extra = { has_nbt: 0, can_place_on: [], can_destroy: [] };
const item = (id: number, count = 1): ItemV4 & { extra: unknown } => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: id * 10, block_runtime_id: 0, extra });

function setup() {
  const handlers = new Map<string, ((p: Record<string, unknown>) => void)[]>();
  const queued: [string, Record<string, unknown>][] = [];
  const source = {
    on(name: string, fn: (p: Record<string, unknown>) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      return () => {};
    },
    queue(name: string, params: Record<string, unknown>) {
      queued.push([name, params]);
    },
  };
  const receive = (name: string, p: object) => {
    for (const fn of handlers.get(name) ?? []) fn(p as Record<string, unknown>);
  };
  const inventory = new Inventory((i) => (i.network_id ? { name: `item${i.network_id}`, networkId: i.network_id, count: i.count, metadata: 0 } : null), () => 5n);
  const hotbar = new Hotbar(source, { inventory, runtimeId: () => 5n });
  return { hotbar, inventory, queued, receive };
}

describe('Hotbar', () => {
  it('sends mob_equipment with the raw item and updates the selected slot', () => {
    const { hotbar, inventory, queued, receive } = setup();
    receive('inventory_content', { window_id: 'inventory', input: [item(1), null, item(3)] });
    receive('inventory_transaction', {
      transaction: { transaction_type: 'normal', actions: [{ source_type: 'container', window_id: 0, slot: 3, old_item: item(0), new_item: item(346) }] },
    });
    receive('inventory_slot', { window_id: 'inventory', slot: 4, item: item(341) });
    receive('inventory_slot', { window_id: 'armor', slot: 5, item: item(999) });
    expect(hotbar.select(3)).toBe(true);
    expect(inventory.selected).toBe(3);
    expect(queued).toEqual([['mob_equipment', { runtime_entity_id: 5n, item: item(346), slot: 3, selected_slot: 3, window_id: 'inventory' }]]);
    expect(hotbar.rawItem(4)).toEqual(item(341));
    expect(hotbar.rawItem(5)).toBeUndefined();
  });

  it('an empty slot is sent as air; bad slots are refused', () => {
    const { hotbar, queued } = setup();
    expect(hotbar.select(7)).toBe(true);
    expect((queued[0]![1].item as ItemV4).network_id).toBe(0);
    expect(hotbar.select(9)).toBe(false);
    expect(hotbar.select(-1)).toBe(false);
    expect(hotbar.select(1.5)).toBe(false);
    expect(queued).toHaveLength(1);
  });
});
