/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Flight kit ops (skills/fly/kitops.ts): rockets into a full hotbar park its least useful item first.
import { describe, expect, it } from 'vitest';
import { FlightKitOps, type KitOpsDeps } from '../../../src/skills/fly/kitops.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const item = (name: string, count = 1): ItemStack => ({ name, count, networkId: 1, metadata: 0 });

function harness(slots: (ItemStack | null)[]) {
  const inv: (ItemStack | null)[] = [...slots, ...Array.from({ length: 36 - slots.length }, () => null)];
  const moves: string[] = [];
  const deps = {
    inventory: { slots: inv, selected: 0, window: () => undefined, freeSlots: () => inv.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0) },
    armour: { wear: async () => true, worn: () => [] },
    requests: { withScreen: async <T>(fn: () => Promise<T>) => fn() },
    move: async (src: { slot: number }, dst: { slot: number }, count: number) => {
      if (inv[dst.slot]) return { ok: false, reason: 'occupied' };
      moves.push(`${src.slot}->${dst.slot} x${count}`);
      inv[dst.slot] = inv[src.slot]!;
      inv[src.slot] = null;
      return { ok: true };
    },
    skills: {} as KitOpsDeps['skills'],
    blockAt: () => undefined,
    position: () => undefined,
    waitTicks: async () => undefined,
  } as unknown as KitOpsDeps;
  return { ops: new FlightKitOps(deps), inv, moves };
}

describe('flight kit: rocketsToHotbar', () => {
  it('a free hotbar slot takes the rockets', async () => {
    const h = harness([item('netherite_pickaxe'), null, ...Array.from({ length: 7 }, () => item('green_shulker_box')), item('firework_rocket', 64)]);
    expect(await h.ops.rocketsToHotbar()).toEqual({ ok: true });
    expect(h.moves).toEqual(['9->1 x64']);
  });

  it('a hotbar full of tools and shulker boxes: a box is parked in the main inventory, the rockets take its slot', async () => {
    const h = harness([item('netherite_pickaxe'), item('netherite_sword'), item('netherite_shovel'), item('netherite_axe'), ...Array.from({ length: 5 }, () => item('green_shulker_box')), item('firework_rocket', 64)]);
    expect(await h.ops.rocketsToHotbar()).toEqual({ ok: true });
    expect(h.moves).toEqual(['8->10 x1', '9->8 x64']);
    expect(h.inv[8]?.name).toBe('firework_rocket');
    expect(h.inv.slice(0, 4).map((s) => s?.name)).toEqual(['netherite_pickaxe', 'netherite_sword', 'netherite_shovel', 'netherite_axe']);
  });

  it('hotbar and main inventory full: refused with the reason', async () => {
    const h = harness([...Array.from({ length: 9 }, () => item('green_shulker_box')), item('firework_rocket', 64), ...Array.from({ length: 26 }, () => item('sand', 64))]);
    const r = await h.ops.rocketsToHotbar();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('inventory is full');
  });
});
