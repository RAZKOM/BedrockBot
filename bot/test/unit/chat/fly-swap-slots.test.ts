/* eslint-disable @typescript-eslint/require-await -- the fake answers like the async request it stands for */
// chat/commands-fly.ts swapSlots: the flight kit's full-inventory rocket move (predicted, rolled back when refused).
import { describe, expect, it } from 'vitest';
import { swapSlots } from '../../../src/chat/commands-fly.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const item = (name: string, stackId: number): ItemStack => ({ name, count: 1, networkId: 1, metadata: 0, stackId });

function inv() {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  slots[8] = item('green_shulker_box', 5);
  slots[20] = item('firework_rocket', 7);
  return { slots, setItem: (_w: number, s: number, it: ItemStack | null) => void (slots[s] = it) };
}

describe('swapSlots', () => {
  it('sends one swap request with both stack ids and keeps the prediction when accepted', async () => {
    const i = inv();
    const sent: Record<string, unknown>[][] = [];
    const r = await swapSlots({ send: async (a: Record<string, unknown>[]) => (sent.push(a), { status: 'ok', request_id: 1 }) } as never, i, 20, 8);
    expect(r.ok).toBe(true);
    expect(i.slots[8]?.name).toBe('firework_rocket');
    expect(i.slots[20]?.name).toBe('green_shulker_box');
    expect(sent[0]![0]).toMatchObject({ type_id: 'swap', source: { slot: 20, stack_id: 7 }, destination: { slot: 8, stack_id: 5 } });
  });
  it('rolls both slots back when refused', async () => {
    const i = inv();
    const r = await swapSlots({ send: async () => ({ status: 'error', request_id: 1 }) } as never, i, 20, 8);
    expect(r.ok).toBe(false);
    expect(i.slots[8]?.name).toBe('green_shulker_box');
    expect(i.slots[20]?.name).toBe('firework_rocket');
  });
});
