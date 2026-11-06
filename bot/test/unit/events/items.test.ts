// Inventory diffs (decision 0059, docs/events.md "Batching"): items.changed per job / per minute,
// container deposit / withdraw per open, the settle window after a spawn, resource.low edges.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../../src/events/bus.ts';
import { ItemTally, type TallyInventory } from '../../../src/events/items.ts';
import type { BotEvent } from '../../../src/events/registry.ts';
import { ResourceWatch } from '../../../src/events/resources.ts';
import type { ItemStack } from '../../../src/world/types.ts';

class FakeInventory implements TallyInventory {
  readonly windows = new Map<number, (ItemStack | null)[]>([[0, new Array<ItemStack | null>(36).fill(null)], [119, [null]], [120, [null, null, null, null]]]);
  private readonly fns = new Set<(w: number, s: number | undefined) => void>();
  window(id: number) {
    const slots = this.windows.get(id);
    return slots ? { slots } : undefined;
  }
  onChange(fn: (w: number, s: number | undefined) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  set(slot: number, name: string | null, count = 1, damage?: number, window = 0): void {
    this.windows.get(window)![slot] = name ? ({ name, count, ...(damage !== undefined ? { damage } : {}) } as ItemStack) : null;
    for (const f of this.fns) f(window, slot);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('item tally', () => {
  let bus: EventBus;
  let inv: FakeInventory;
  let seen: BotEvent[];
  let tally: ItemTally;
  let t: number;
  beforeEach(() => {
    bus = new EventBus();
    bus.strict = true;
    inv = new FakeInventory();
    seen = [];
    bus.subscribe((e) => seen.push(e));
    t = 1_762_300_000_000;
    tally = new ItemTally({ inventory: inv, bus, now: () => t, settleMs: 3000, blockAt: () => 'chest' });
  });
  afterEach(() => {
    tally.stop();
  });

  it('the first count after a spawn is the baseline; later changes are gained / lost; one event per flush', async () => {
    inv.set(0, 'iron_sword');
    inv.set(1, 'bread', 10);
    await tick();
    tally.reset(); // spawn: the next 3 s only set the baseline
    inv.set(2, 'iron_chestplate', 1, undefined, 120);
    await tick();
    t += 4000;
    inv.set(3, 'cobblestone', 32);
    inv.set(1, 'bread', 7);
    await tick();
    inv.set(3, 'cobblestone', 40);
    await tick();
    tally.flush();
    tally.flush(); // nothing new: no second event
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe('items.changed');
    expect(seen[0]!.data).toMatchObject({ gained: { cobblestone: 40 }, lost: { bread: 3 }, jobs: [] });
  });

  it('a storage window turns the deltas into one deposit and one withdraw with the position; a workbench does not', async () => {
    inv.set(0, 'cobblestone', 64);
    inv.set(1, 'oak_log', 4);
    await tick();
    t += 4000;
    tally.containerOpen({ x: 100, y: 64, z: -50 }, 'container');
    inv.set(0, null);
    inv.set(2, 'bread', 16);
    await tick();
    tally.containerClose();
    tally.containerOpen({ x: 101, y: 64, z: -50 }, 'workbench');
    inv.set(1, 'oak_log', 3);
    inv.set(4, 'oak_planks', 4);
    await tick();
    tally.containerClose();
    tally.flush();
    expect(seen.map((e) => e.kind)).toEqual(['container.deposit', 'container.withdraw', 'items.changed']);
    expect(seen[0]!.data).toEqual({ at: { x: 100, y: 64, z: -50 }, block: 'chest', items: { cobblestone: 64 } });
    expect(seen[1]!.data).toEqual({ at: { x: 100, y: 64, z: -50 }, block: 'chest', items: { bread: 16 } });
    expect(seen[2]!.data).toMatchObject({ gained: { oak_planks: 4 }, lost: { oak_log: 1 } });
  });

  it('a job end flushes the batch and names the job; a running job is named in later batches', async () => {
    tally.diff(); // the baseline (empty)
    t += 4000;
    bus.emit('job.started', { job: 'mine', kind: 'user', line: 'mine' });
    bus.emit('job.started', { job: 'gather', kind: 'user', line: 'gather' });
    inv.set(0, 'coal', 5);
    await tick();
    bus.emit('job.finished', { job: 'mine', result: 'done', durationS: 1 });
    inv.set(1, 'oak_log', 2);
    await tick();
    tally.flush();
    const items = seen.filter((e) => e.kind === 'items.changed');
    expect(items.map((e) => e.data)).toMatchObject([
      { gained: { coal: 5 }, jobs: ['mine', 'gather'] },
      { gained: { oak_log: 2 }, jobs: ['gather'] },
    ]);
  });
});

describe('resource watch', () => {
  let bus: EventBus;
  let inv: FakeInventory;
  let seen: BotEvent[];
  let watch: ResourceWatch;
  let limit: number;
  beforeEach(() => {
    bus = new EventBus();
    bus.strict = true;
    inv = new FakeInventory();
    seen = [];
    limit = 10;
    bus.subscribe((e) => seen.push(e));
    inv.set(0, 'bread', 10);
    inv.set(1, 'iron_pickaxe', 1, 100);
    watch = new ResourceWatch({ inventory: inv, bus, immediate: true, toolWearLimit: () => limit, fireworksMin: () => 16 });
    watch.enable();
  });
  afterEach(() => {
    watch.stop();
  });

  const lows = () => seen.map((e) => (e.data as { resource: string; detail: string }));

  it('food: once at 2 or fewer (bad food does not count), again only after it was back at 5', () => {
    inv.set(0, 'bread', 2);
    inv.set(2, 'rotten_flesh', 20);
    inv.set(0, 'bread', 1);
    expect(lows()).toEqual([{ resource: 'food', left: 2, detail: '2 food item(s) left' }]);
    inv.set(0, 'bread', 5);
    inv.set(0, null);
    expect(lows().map((l) => l.detail)).toEqual(['2 food item(s) left', 'no food carried']);
  });

  it('tools: the best of a class at toolWearLimit or below, while one is carried', () => {
    inv.set(1, 'iron_pickaxe', 1, 245); // 5 uses left
    expect(lows()).toEqual([{ resource: 'tools', left: 5, detail: 'iron_pickaxe: 5 use(s) left (toolWearLimit 10)' }]);
    inv.set(3, 'stone_pickaxe', 1, 0); // a good one again: re-armed
    inv.set(3, null);
    expect(lows()).toHaveLength(2);
    inv.set(1, null); // no pickaxe at all: not "low"
    expect(lows()).toHaveLength(2);
  });

  it('fireworks: only with an elytra', () => {
    inv.set(4, 'firework_rocket', 3);
    expect(lows()).toEqual([]);
    inv.set(1, 'elytra', 1, 0, 120);
    expect(lows()).toEqual([{ resource: 'fireworks', left: 3, detail: '3 rocket(s) carried, fireworksMin 16' }]);
  });

  it('nothing while disabled (before the inventory arrived)', () => {
    watch.enable(false);
    inv.set(0, null);
    expect(seen).toEqual([]);
  });
});
